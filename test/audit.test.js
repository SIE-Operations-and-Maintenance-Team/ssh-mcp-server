import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("audit-store", () => {
  it("should log and query (memory fallback)", async () => {
    const { AuditStore } = await import("../build/services/audit-store.js");
    const s = new AuditStore(":memory:");
    // 显式 ts 保证排序确定（同毫秒内两次 log 的先后不可依赖）
    s.log({ ts: 1000, connection: "dev", tool: "execute-command", status: "ok", sql: "ls" });
    s.log({ ts: 2000, connection: "prod", tool: "sftp-upload", status: "fail", sql: "put" });
    const r = s.query({ page: 1, pageSize: 10 });
    assert.equal(r.total, 2);
    assert.equal(r.rows.length, 2);
    // 命令明细必须随记录往返（审计页预览依赖此字段）
    assert.equal(r.rows[0].sql, "put");
    assert.equal(r.rows[1].sql, "ls");
    const filtered = s.query({ page: 1, pageSize: 10, q: "dev" });
    assert.equal(filtered.total, 1);
    // 关键字可搜到命令内容
    const byCmd = s.query({ page: 1, pageSize: 10, q: "put" });
    assert.equal(byCmd.total, 1);
    assert.equal(byCmd.rows[0].connection, "prod");
  });
  it("GET /admin/api/audit via admin server", async () => {
    const { startAdminServer } = await import("../build/server/index.js");
    const tmp = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "audit-srv-"));
    const cfg = path.join(dir, "config.json");
    await tmp.writeFile(cfg, JSON.stringify({ port: 0, projects: {} }), "utf-8");
    const srv = await startAdminServer({ port: 0, configPath: cfg });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/admin/api/audit?page=1&pageSize=5`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.total === "number");
    } finally { await srv.close(); await tmp.rm(dir, { recursive: true, force: true }); }
  });
});
