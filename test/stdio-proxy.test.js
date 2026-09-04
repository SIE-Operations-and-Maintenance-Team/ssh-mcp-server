import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";
import {
  probeAdminServer,
  extractResponseJsonLines,
  getAdminServerVersion,
  compareVersions,
  parseListenerOutput,
  findListenerPids,
} from "../build/cli/stdio-proxy.js";

const rootDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

function startStubAdmin(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const handler = handlers[req.url.split("?")[0]] || (() => { res.writeHead(404); res.end(); });
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

describe("stdio-proxy", () => {
  describe("extractResponseJsonLines", () => {
    it("passes through an application/json body as one line", async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      const res = new Response(body, { headers: { "content-type": "application/json" } });
      assert.deepEqual(await extractResponseJsonLines(res), [body]);
    });

    it("returns nothing for an empty json body", async () => {
      const res = new Response("", { headers: { "content-type": "application/json" }, status: 202 });
      assert.deepEqual(await extractResponseJsonLines(res), []);
    });

    it("parses data payloads from a text/event-stream body", async () => {
      const first = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
      const second = JSON.stringify({ jsonrpc: "2.0", method: "notify/progress", params: {} });
      const sse = `event: message\r\ndata: ${first}\r\n\r\ndata: ${second}\r\n\r\ndata: [DONE]\r\n\r\n`;
      const res = new Response(sse, { headers: { "content-type": "text/event-stream" } });
      assert.deepEqual(await extractResponseJsonLines(res), [first, second]);
    });

    it("drops non-json bodies", async () => {
      const res = new Response("oops", { headers: { "content-type": "text/plain" } });
      assert.deepEqual(await extractResponseJsonLines(res), []);
    });
  });

  describe("probeAdminServer", () => {
    it("returns true when system/info answers with our payload shape", async () => {
      const { server, port } = await startStubAdmin({
        "/admin/api/system/info": (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ port, version: "1.1.0", platform: process.platform }));
        },
      });
      try {
        assert.equal(await probeAdminServer(port), true);
      } finally {
        server.close();
      }
    });

    it("returns false for a foreign service or a closed port", async () => {
      const { server, port } = await startStubAdmin({
        "/admin/api/system/info": (_req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html>not us</html>");
        },
      });
      try {
        assert.equal(await probeAdminServer(port), false);
      } finally {
        server.close();
      }
      assert.equal(await probeAdminServer(port, 300), false);
    });
  });

  describe("compareVersions", () => {
    it("orders patch, minor and major segments", () => {
      assert.ok(compareVersions("1.1.1", "1.1.2") < 0);
      assert.ok(compareVersions("1.1.2", "1.1.1") > 0);
      assert.ok(compareVersions("1.2.0", "1.1.9") > 0);
      assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    });

    it("compares multi-digit segments numerically and treats missing segments as zero", () => {
      assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
      assert.equal(compareVersions("1.2.0", "1.2"), 0);
      assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    });
  });

  describe("getAdminServerVersion", () => {
    it("returns the version string from system/info", async () => {
      const { server, port } = await startStubAdmin({
        "/admin/api/system/info": (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: "1.1.1", port }));
        },
      });
      try {
        assert.equal(await getAdminServerVersion(port), "1.1.1");
      } finally {
        server.close();
      }
    });

    it("returns null for a missing version field or a closed port", async () => {
      const { server, port } = await startStubAdmin({
        "/admin/api/system/info": (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ port }));
        },
      });
      try {
        assert.equal(await getAdminServerVersion(port), null);
      } finally {
        server.close();
      }
      assert.equal(await getAdminServerVersion(port, 300), null);
    });
  });

  describe("parseListenerOutput", () => {
    it("parses Windows netstat -ano lines and matches the local port exactly", () => {
      const stdout = [
        "",
        "  协议  本地地址          外部地址        状态           PID",
        "  TCP    127.0.0.1:61823        0.0.0.0:0              LISTENING       7732",
        "  TCP    [::1]:61823            [::]:0                 LISTENING       7732",
        "  TCP    0.0.0.0:618231         0.0.0.0:0              LISTENING       999",
        "  TCP    127.0.0.1:61823        1.2.3.4:443            ESTABLISHED     7732",
        "  TCP    127.0.0.1:135          0.0.0.0:0              LISTENING       1234",
        "",
      ].join("\r\n");
      assert.deepEqual(parseListenerOutput(stdout, "win32", 61823), [7732]);
      // 端口 6182 不能误匹配 :61823
      assert.deepEqual(parseListenerOutput(stdout, "win32", 6182), []);
    });

    it("parses lsof -t output lines on unix", () => {
      assert.deepEqual(parseListenerOutput("7732\n\n8100\n", "linux", 61823), [7732, 8100]);
      assert.deepEqual(parseListenerOutput("", "linux", 61823), []);
    });
  });

  describe("findListenerPids (integration)", () => {
    it("finds the current process listening on an ephemeral port", async (t) => {
      const server = net.createServer(() => {});
      const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
      try {
        const pids = await findListenerPids(port);
        if (pids.length === 0) return t.skip("netstat/lsof 在当前环境不可用");
        assert.ok(pids.includes(process.pid), `期望包含当前进程 ${process.pid}，实际 ${pids}`);
      } finally {
        server.close();
      }
    });
  });

  describe("proxy round-trip (child process)", () => {
    it("forwards a JSON-RPC request to the admin /mcp endpoint and writes the response to stdout", async () => {
      const { server, port } = await startStubAdmin({
        "/admin/api/system/info": (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: "stub", port }));
        },
        "/mcp": (req, res) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            const reqBody = JSON.parse(raw);
            if (Array.isArray(reqBody) || typeof reqBody?.id !== "undefined") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ jsonrpc: "2.0", id: reqBody.id, result: { echo: reqBody.method } }));
            } else {
              res.writeHead(202);
              res.end();
            }
          });
        },
      });
      try {
        const child = spawn(process.execPath, [path.join(rootDir, "build", "index.js"), "--admin-port", String(port)], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (c) => (stderr += c));
        const stdoutLines = [];
        const done = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for response, stderr=${stderr}`)), 10000);
          let buf = "";
          child.stdout.on("data", (c) => {
            buf += c;
            let idx;
            while ((idx = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (line) stdoutLines.push(line);
              if (stdoutLines.length >= 1) {
                clearTimeout(timer);
                resolve();
              }
            }
          });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        await done;
        const response = JSON.parse(stdoutLines[0]);
        assert.equal(response.id, 1);
        assert.equal(response.result.echo, "initialize");
        // 通知无响应，仅一条请求响应回写
        assert.equal(stdoutLines.length, 1);
        child.stdin.end();
        await new Promise((resolve) => child.once("exit", resolve));
      } finally {
        server.close();
      }
    });
  });
});
