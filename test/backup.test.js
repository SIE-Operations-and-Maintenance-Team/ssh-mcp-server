import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("backup", () => {
  it("should snapshot and list and restore", async () => {
    const { ConfigStore } = await import("../build/services/config-store.js");
    const { BackupService } = await import("../build/services/backup-service.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-svc-"));
    const cfgPath = path.join(dir, "config.json");
    const store = new ConfigStore({ configPath: cfgPath });
    await store.save({ port: 61823, projects: { default: { displayName: "默认项目", environments: { default: { displayName: "默认环境", hosts: { a: { name: "a", host: "h", port: 22, username: "u" } } } } } } });
    const svc = new BackupService(store);
    const snap = await svc.snapshot();
    assert.ok(snap.name.endsWith(".json"));
    const list = await svc.list();
    assert.ok(list.length >= 1);
    // modify then restore
    await store.save({ port: 9999, projects: {} });
    await svc.restore(list[0].id);
    const reloaded = await store.load();
    assert.equal(reloaded.port, 61823);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("GET /admin/api/backups via admin server", async () => {
    const { startAdminServer } = await import("../build/server/index.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-srv-"));
    const cfg = path.join(dir, "config.json");
    await fs.writeFile(cfg, JSON.stringify({ port: 0, projects: {} }), "utf-8");
    const srv = await startAdminServer({ port: 0, configPath: cfg });
    try {
      const r1 = await fetch(`http://127.0.0.1:${srv.port}/admin/api/backups`);
      assert.equal(r1.status, 200);
      const list = await r1.json();
      assert.ok(Array.isArray(list));
    } finally { await srv.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
