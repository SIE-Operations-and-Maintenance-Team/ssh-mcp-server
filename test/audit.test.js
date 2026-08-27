import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("audit-store", () => {
  it("should log and query (memory fallback)", async () => {
    const { AuditStore } = await import("../build/services/audit-store.js");
    const s = new AuditStore(":memory:");
    s.log({ connection: "dev", tool: "execute-command", status: "ok", sql: "ls" });
    s.log({ connection: "prod", tool: "sftp-upload", status: "fail", sql: "put" });
    const r = s.query({ page: 1, pageSize: 10 });
    assert.equal(r.total, 2);
    assert.equal(r.rows.length, 2);
    const filtered = s.query({ page: 1, pageSize: 10, q: "dev" });
    assert.equal(filtered.total, 1);
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
