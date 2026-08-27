import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../build/tools/index.js";
import { SSHConnectionManager } from "../build/services/ssh-connection-manager.js";

// ---- fake ssh2 surface -------------------------------------------------

class FakeExecStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.exitCode = 0;
  }
  close() {
    this.emit("close", this.exitCode, undefined);
  }
}

class FakeSftp extends EventEmitter {
  constructor() {
    super();
    this.statCalls = [];
    this.fastPutCalls = [];
    this.fastGetCalls = [];
    this.remoteContent = Buffer.from("hello from remote");
    this.remoteSize = this.remoteContent.length;
  }
  end() {
    this.emit("end");
  }
  stat(remotePath, callback) {
    this.statCalls.push(remotePath);
    setImmediate(() => callback(undefined, { size: this.remoteSize, isFile: () => true }));
  }
  fastPut(localPath, remotePath, options, callback) {
    this.fastPutCalls.push({ localPath, remotePath, options });
    setImmediate(() => callback());
  }
  fastGet(remotePath, localPath, options, callback) {
    this.fastGetCalls.push({ remotePath, localPath, options });
    fs.writeFileSync(localPath, this.remoteContent);
    setImmediate(() => callback());
  }
  createWriteStream(remotePath, _options) {
    return new Writable({ write(_chunk, _enc, cb) { cb(); } });
  }
  createReadStream(remotePath, _options) {
    return Readable.from([this.remoteContent]);
  }
}

class FakeClient extends EventEmitter {
  constructor(handlers = {}) {
    super();
    this.handlers = handlers;
    this.connectCalls = [];
    this.execCalls = [];
    this.sftpCalls = 0;
  }
  connect(config) {
    this.connectCalls.push(config);
    this.handlers.onConnect?.(config, this);
  }
  exec(command, options, callback) {
    this.execCalls.push({ command, options });
    this.handlers.onExec?.({ command, options, callback }, this);
  }
  sftp(callback) {
    this.sftpCalls += 1;
    this.handlers.onSftp?.(callback, this);
  }
  end() {
    this.emit("close");
  }
  destroy() {
    this.emit("close");
  }
}

function makeClient(scenario = {}) {
  return new FakeClient({
    onConnect(_config, client) {
      setImmediate(() => client.emit("ready"));
    },
    onExec({ command, callback }, _client) {
      setImmediate(() => {
        const stream = new FakeExecStream();
        stream.exitCode = scenario.exitCode ?? 0;
        callback(null, stream);
        setImmediate(() => {
          const out =
            typeof scenario.output === "function"
              ? scenario.output(command)
              : scenario.output;
          stream.emit("data", Buffer.from(out ?? ""));
          stream.emit("exit", stream.exitCode, undefined);
          stream.close();
        });
      });
    },
    onSftp(callback, _client) {
      const sftp = scenario.sftp ?? new FakeSftp();
      setImmediate(() => callback(null, sftp));
    },
  });
}

// ---- harness ------------------------------------------------------------

const manager = SSHConnectionManager.getInstance();

async function withMcpServer(run) {
  const server = new McpServer({ name: "ssh-mcp-server", version: "0.0.0" });
  registerAllTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function baseConfig(overrides = {}) {
  return {
    name: "dev",
    host: "10.0.0.1",
    port: 22,
    username: "devuser",
    password: "secret",
    commandWhitelist: ["^ls"],
    allowedRemotePaths: ["/tmp"],
    ...overrides,
  };
}

describe("E2E: MCP server through the real tool layer (mocked SSH)", () => {
  let originalCreateClient;
  let originalScheduleStatusCollection;

  before(() => {
    originalCreateClient = manager.createClient;
    originalScheduleStatusCollection = manager.scheduleStatusCollection;
  });

  afterEach(() => {
    manager.disconnect();
    manager.createClient = originalCreateClient;
    manager.scheduleStatusCollection = originalScheduleStatusCollection;
  });

  it("list-servers returns configured hosts as text + JSON", async () => {
    manager.setConfig({ dev: baseConfig() });
    await withMcpServer(async (client) => {
      const res = await callTool(client, "list-servers", {});
      const text = res.content[0].text;
      assert.match(text, /Configured SSH servers:/);
      assert.match(text, /\[disconnected\] dev/);
      assert.match(text, /devuser@10\.0\.0\.1:22/);
      assert.ok(text.includes("Raw JSON:"));
    });
  });

  it("execute-command runs a whitelisted command and returns stdout", async () => {
    const fake = makeClient({ output: "hello\nworld\n" });
    manager.setConfig({ dev: baseConfig() });
    manager.createClient = () => fake;
    manager.scheduleStatusCollection = () => {};
    await withMcpServer(async (client) => {
      const res = await callTool(client, "execute-command", { cmdString: "ls -la" });
      assert.equal(res.isError, undefined);
      const text = res.content[0].text;
      assert.match(text, /hello/);
      assert.match(text, /world/);
    });
    assert.equal(fake.execCalls.length, 1);
    assert.equal(fake.execCalls[0].command, "ls -la");
    assert.deepEqual(fake.execCalls[0].options, { pty: true });
    assert.equal(manager.getClient("dev"), fake);
  });

  it("execute-command rejects a command outside the whitelist", async () => {
    manager.setConfig({ dev: baseConfig() });
    await withMcpServer(async (client) => {
      const res = await callTool(client, "execute-command", { cmdString: "rm -rf /" });
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.code, "COMMAND_VALIDATION_FAILED");
      assert.equal(parsed.retriable, false);
    });
  });

  it("upload sends a large local file through sftp.fastPut", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".e2e-up-"));
    const localFile = path.join(tmpDir, "big.bin");
    fs.writeFileSync(localFile, Buffer.alloc(300 * 1024, 7));
    const sftp = new FakeSftp();
    const fake = makeClient({ sftp });
    manager.setConfig({ dev: baseConfig() });
    manager.createClient = () => fake;
    manager.scheduleStatusCollection = () => {};
    try {
      await withMcpServer(async (client) => {
        const res = await callTool(client, "upload", {
          localPath: localFile,
          remotePath: "/tmp/big.bin",
        });
        assert.equal(res.isError, undefined);
        assert.match(res.content[0].text, /uploaded successfully/i);
      });
      assert.equal(sftp.fastPutCalls.length, 1);
      assert.equal(sftp.fastPutCalls[0].localPath, localFile);
      assert.equal(sftp.fastPutCalls[0].remotePath, "/tmp/big.bin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("upload rejects a remote path outside allowedRemotePaths", async () => {
    manager.setConfig({ dev: baseConfig() });
    await withMcpServer(async (client) => {
      const res = await callTool(client, "upload", {
        localPath: path.join(process.cwd(), "package.json"),
        remotePath: "/etc/passwd",
      });
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.code, "REMOTE_PATH_NOT_ALLOWED");
    });
  });

  it("upload rejects a local path outside the allowed roots", async () => {
    manager.setConfig({ dev: baseConfig() });
    await withMcpServer(async (client) => {
      const res = await callTool(client, "upload", {
        localPath: path.join(os.tmpdir(), "ssh-mcp-e2e-outside.txt"),
        remotePath: "/tmp/ok.txt",
      });
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.code, "LOCAL_PATH_NOT_ALLOWED");
    });
  });

  it("download saves remote content via the streaming SFTP path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".e2e-dl-"));
    const localFile = path.join(tmpDir, "out.txt");
    const sftp = new FakeSftp();
    sftp.remoteContent = Buffer.from("hello from remote");
    sftp.remoteSize = sftp.remoteContent.length;
    manager.setConfig({ dev: baseConfig() });
    manager.createClient = () => makeClient({ sftp });
    manager.scheduleStatusCollection = () => {};
    try {
      await withMcpServer(async (client) => {
        const res = await callTool(client, "download", {
          remotePath: "/tmp/data.txt",
          localPath: localFile,
        });
        assert.equal(res.isError, undefined);
        assert.match(res.content[0].text, /downloaded successfully/i);
      });
      assert.equal(fs.readFileSync(localFile, "utf8"), "hello from remote");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("upload on a shell-mode connection is rejected as unsupported", async () => {
    manager.setConfig({ bastion: baseConfig({ name: "bastion", transportMode: "shell" }) });
    await withMcpServer(async (client) => {
      const res = await callTool(client, "upload", {
        connectionName: "bastion",
        localPath: path.join(process.cwd(), "package.json"),
        remotePath: "/tmp/x",
      });
      assert.equal(res.isError, true);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.code, "UNSUPPORTED_IN_SHELL_MODE");
    });
  });
});