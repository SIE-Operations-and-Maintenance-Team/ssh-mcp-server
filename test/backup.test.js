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
  it("list() 使用文件名内嵌时间戳而非 mtime", async () => {
    const { ConfigStore } = await import("../build/services/config-store.js");
    const { BackupService } = await import("../build/services/backup-service.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-ts-"));
    const cfgPath = path.join(dir, "config.json");
    await fs.writeFile(cfgPath, JSON.stringify({ port: 0, projects: {} }), "utf-8");
    const store = new ConfigStore({ configPath: cfgPath });
    const svc = new BackupService(store);
    const backupDir = path.join(dir, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    // 标准命名：mtime 故意写成一个完全不同的时间，list 应取文件名时间
    const stdName = "config-2026-08-26T03-10-00-930Z.json";
    await fs.writeFile(path.join(backupDir, stdName), "{}", "utf-8");
    const fakeMtime = new Date(Date.UTC(2020, 0, 1));
    await fs.utimes(path.join(backupDir, stdName), fakeMtime, fakeMtime);
    // 非标准命名：回退 mtime
    const oddName = "manual-copy.json";
    await fs.writeFile(path.join(backupDir, oddName), "{}", "utf-8");
    const oddMtime = new Date(Date.UTC(2021, 5, 15));
    await fs.utimes(path.join(backupDir, oddName), oddMtime, oddMtime);
    const list = await svc.list();
    const std = list.find((i) => i.id === stdName);
    const odd = list.find((i) => i.id === oddName);
    assert.equal(std.ts, Date.UTC(2026, 7, 26, 3, 10, 0, 930));
    assert.equal(odd.ts, oddMtime.getTime());
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("prune 按 maxCount 删除超出数量的最旧备份", async () => {
    const { ConfigStore } = await import("../build/services/config-store.js");
    const { BackupService } = await import("../build/services/backup-service.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-prune-"));
    const cfgPath = path.join(dir, "config.json");
    await fs.writeFile(cfgPath, JSON.stringify({ port: 0, projects: {} }), "utf-8");
    const store = new ConfigStore({ configPath: cfgPath });
    const svc = new BackupService(store);
    const backupDir = path.join(dir, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    // 造 12 份按时间命名的历史备份
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.UTC(2026, 7, 1, 0, i, 0, 0));
      const name = `config-${d.toISOString().replace(/[:.]/g, "-")}.json`;
      await fs.writeFile(path.join(backupDir, name), "{}", "utf-8");
    }
    const { deleted } = await svc.prune(undefined, 10);
    assert.equal(deleted.length, 2);
    const remaining = await svc.list();
    assert.equal(remaining.length, 10);
    // 保留的应是最新的 10 份（00:03 ~ 00:12），删除的应是最旧的 00:01/00:02
    assert.ok(deleted.every((id) => id.includes("T00-01-") || id.includes("T00-02-")));
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
