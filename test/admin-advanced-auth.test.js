import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises"; import path from "node:path"; import os from "node:os";
describe("connections advanced auth", ()=>{
  let srv; let cfgPath;
  before(async()=>{
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"ssh-mcp-adv-"));
    cfgPath = path.join(tmp,"config.json");
    const { startAdminServer } = await import("../build/server/index.js");
    srv = await startAdminServer({ port:0, configPath: cfgPath });
  });
  after(async()=>{ await srv?.close(); });
  it("should persist privateKey/passphrase/agent/tryKeyboard", async()=>{
    const payload = { name:"auth-dev", host:"1.2.3.4", port:22, username:"alice", privateKey:"~/.ssh/id_rsa", passphrase:"p123", agent:"pageant", tryKeyboard:true };
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    assert.equal(r.status,200);
    const list = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`)).json();
    const key = list["default/default/auth-dev"] ? "default/default/auth-dev" : "auth-dev";
    assert.equal(list[key].tryKeyboard,true);
    assert.match(list[key].privateKey, /id_rsa$/);
  });
});
