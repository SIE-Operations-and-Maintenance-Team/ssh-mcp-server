import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// 闭环验证：UI 写入的配置（ConfigStore）必须能被 HTTP /mcp 读到，
// 且执行失败会写入审计流水（/admin/api/audit 可查）。
describe("admin server MCP closed loop", () => {
  let srv;
  let cfgPath;
  let auditStore;

  before(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-loop-"));
    cfgPath = path.join(tmp, "config.json");
    // 端口 1 在本机立即拒连，保证 execute-command 快速失败而不会挂起
    await fs.writeFile(cfgPath, JSON.stringify({
      port: 0,
      audit: { enabled: true, logResults: true },
      projects: {
        ops: {
          environments: {
            prod: { hosts: { "web-01": { name: "web-01", host: "127.0.0.1", port: 1, username: "root", password: "x" } } },
          },
        },
      },
    }));
    const { startAdminServer } = await import("../build/server/index.js");
    const { globalAuditStore } = await import("../build/services/audit-store.js");
    auditStore = globalAuditStore;
    srv = await startAdminServer({ port: 0, configPath: cfgPath });
  });

  after(async () => {
    // 清理写入真实审计库的测试行，避免污染用户审计页
    try {
      const db = auditStore?.db;
      if (db) db.prepare(`DELETE FROM audit WHERE connection = ?`).run("ops/prod/web-01");
    } catch {}
    await srv?.close();
    try { await fs.unlink(cfgPath); } catch {}
  });

  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    return await r.text();
  };

  it("HTTP /mcp sees UI-configured hosts", async () => {
    const text = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list-servers", arguments: {} } });
    assert.match(text, /web-01/);
    assert.doesNotMatch(text, /No SSH servers configured/);
  });

  it("exposes list-directory tool and audits its failures", async () => {
    const listText = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.match(listText, /list-directory/);
    const text = await call({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "list-directory", arguments: { remotePath: "/tmp", connectionName: "ops/prod/web-01" } },
    });
    assert.match(text, /isError":true/);
    const audit = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/audit?tool=list-directory`)).json();
    assert.ok(audit.total >= 1, `expected list-directory audit rows, got ${audit.total}`);
    assert.equal(audit.rows[0].status, "fail");
  });

  it("audits failed execute-command", async () => {
    const text = await call({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "execute-command", arguments: { cmdString: "echo hi", connectionName: "ops/prod/web-01" } },
    });
    assert.match(text, /isError":true/);
    const audit = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/audit?connection=ops%2Fprod%2Fweb-01`)).json();
    assert.ok(audit.total >= 1, `expected audit rows, got ${audit.total}`);
    assert.equal(audit.rows[0].tool, "execute-command");
    assert.equal(audit.rows[0].status, "fail");
  });
});
