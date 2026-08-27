import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises"; import path from "node:path"; import os from "node:os";
describe("settings api", ()=>{
  let srv; let cfgPath;
  before(async()=>{
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"ssh-mcp-settings-"));
    cfgPath = path.join(tmp,"config.json");
    const { startAdminServer } = await import("../build/server/index.js");
    srv = await startAdminServer({ port:0, configPath: cfgPath });
  });
  after(()=>srv?.close());
  it("GET defaults and POST persists", async()=>{
    const g0 = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/settings`)).json();
    assert.ok(typeof g0.port === "number");
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/settings`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ audit:{ enabled:true, retentionDays:15, logResults:true }, backups:{ retentionDays:20, maxCount:10 }, preConnect:true })});
    assert.equal(r.status,200);
    const body = await r.json(); assert.equal(body.ok,true);
    const g1 = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/settings`)).json();
    assert.equal(g1.audit.retentionDays,15);
    assert.equal(g1.preConnect,true);
  });
  it("should reject bad port", async()=>{
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/settings`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ port: 99999 })});
    assert.equal(r.status,400);
  });
});
