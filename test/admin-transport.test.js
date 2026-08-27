import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises"; import path from "node:path"; import os from "node:os";
describe("connections transport & proxy", ()=>{
  let srv; let cfgPath;
  before(async()=>{
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"ssh-mcp-trans-"));
    cfgPath = path.join(tmp,"config.json");
    const { startAdminServer } = await import("../build/server/index.js");
    srv = await startAdminServer({ port:0, configPath: cfgPath });
  });
  after(()=>srv?.close());
  it("should persist transportMode shell + template + proxy", async()=>{
    const payload = { name:"bastion", host:"9.9.9.9", port:22, username:"ops", password:"x", transportMode:"shell", shellReadyTimeoutMs:15000, shellCommandTimeoutMs:45000, commandTemplate:"su root -c <quotedCommand>", proxy:"socks5://127.0.0.1:1080", pty:false };
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    assert.equal(r.status,200);
    const list = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`)).json();
    const key = list["default/default/bastion"] ? "default/default/bastion" : "bastion";
    assert.equal(list[key].transportMode,"shell");
    assert.equal(list[key].commandTemplate,"su root -c <quotedCommand>");
  });
  it("should reject bad commandTemplate", async()=>{
    const bad = { name:"bad", host:"h", port:22, username:"u", password:"x", commandTemplate:"echo hi" };
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(bad)});
    assert.equal(r.status,400);
  });
});
