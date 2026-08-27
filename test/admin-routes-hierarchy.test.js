import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAdminRoutes } from "../build/server/routes/admin.js";
import { ConfigStore } from "../build/services/config-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("admin hierarchy routes", () => {
  let app;
  let store;
  let tmp;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `ssh-mcp-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    store = new ConfigStore({ configPath: tmp });
    app = Fastify();
    registerAdminRoutes(app, store);
  });
  afterEach(async () => { await app.close(); try{ await fs.unlink(tmp);}catch{} try{ await fs.unlink(tmp+".bak");}catch{} });

  it("creates project and host then lists", async () => {
    let r = await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:"ops", displayName:"运维" } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method:"POST", url:"/admin/api/projects/ops/environments", payload:{ name:"prod" } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method:"POST", url:"/admin/api/projects/ops/environments/prod/hosts", payload:{ name:"web-01", host:"10.0.0.1", port:22, username:"root" } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method:"GET", url:"/admin/api/projects" });
    const idx = JSON.parse(r.body);
    assert.equal(idx[0].hostCount, 1);
    // 新建项目自动创建 4 个默认环境（DEFAULT_ENVS）+ 手动新增 prod = 5
    assert.equal(idx[0].environmentCount, 5);
  });
  it("host rename via originalName is atomic", async () => {
    await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:"p1" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments", payload:{ name:"dev" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments/dev/hosts", payload:{ name:"h1", host:"1.1.1.1", port:22, username:"u" } });
    const r = await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments/dev/hosts", payload:{ name:"h2", originalName:"h1", host:"1.1.1.1", port:22, username:"u" } });
    assert.equal(r.statusCode, 200);
    const idx = await app.inject({ method:"GET", url:"/admin/api/projects/p1" });
    const proj = JSON.parse(idx.body);
    assert.ok(proj.environments.dev.hosts["h2"]);
    assert.equal(proj.environments.dev.hosts["h1"], undefined);
  });
  it("returns PROJECT_NOT_FOUND for unknown project", async () => {
    const r = await app.inject({ method:"GET", url:"/admin/api/projects/nope" });
    assert.equal(r.statusCode, 404);
    assert.match(JSON.parse(r.body).code, /PROJECT_NOT_FOUND/);
  });
  it("deprecated GET /admin/api/connections returns flat (masking intentionally skipped)", async () => {
    await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:"p1" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments", payload:{ name:"dev" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments/dev/hosts", payload:{ name:"h1", host:"1.1.1.1", port:22, username:"u", password:"secret" } });
    const r = await app.inject({ method:"GET", url:"/admin/api/connections" });
    const body = JSON.parse(r.body);
    const first = Object.values(body)[0];
    // 维持现状：maskHost 暂不打码（用户决定跳过），密码原样返回
    assert.equal(first.password, "secret");
  });
  it("preserves password when not provided on update", async () => {
    await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:"p1" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments", payload:{ name:"dev" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments/dev/hosts", payload:{ name:"h1", host:"1.1.1.1", port:22, username:"u", password:"secret" } });
    await app.inject({ method:"POST", url:"/admin/api/projects/p1/environments/dev/hosts", payload:{ name:"h1", host:"1.1.1.1", port:22, username:"u" } });
    const exp = await app.inject({ method:"GET", url:"/admin/api/config/export" });
    const cfg = JSON.parse(exp.body);
    assert.equal(cfg.projects.p1.environments.dev.hosts.h1.password, "secret");
  });
  it("project rename keeps projectOrder position", async () => {
    for (const n of ["pa","pb","pc"]) await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:n } });
    let r = await app.inject({ method:"POST", url:"/admin/api/projects/reorder", payload:{ order:["pc","pa","pb"] } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method:"POST", url:"/admin/api/projects", payload:{ name:"pa2", originalName:"pa" } });
    assert.equal(r.statusCode, 200);
    const idx = JSON.parse((await app.inject({ method:"GET", url:"/admin/api/projects" })).body);
    assert.deepEqual(idx.map((p) => p.name), ["pc","pa2","pb"]);
  });
  it("DELETE /admin/api/connections/:name returns 404 when not found", async () => {
    const r = await app.inject({ method:"DELETE", url:"/admin/api/connections/ghost" });
    assert.equal(r.statusCode, 404);
    assert.match(JSON.parse(r.body).code, /HOST_NOT_FOUND/);
  });
});
