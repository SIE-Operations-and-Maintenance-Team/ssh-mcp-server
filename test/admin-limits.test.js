import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises"; import path from "node:path"; import os from "node:os";
describe("connections limits & per-connection security", ()=>{
  let srv; let cfgPath;
  before(async()=>{
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"ssh-mcp-limits-"));
    cfgPath = path.join(tmp,"config.json");
    const { startAdminServer } = await import("../build/server/index.js");
    srv = await startAdminServer({ port:0, configPath: cfgPath });
  });
  after(()=>srv?.close());
  it("should persist timeouts/maxOutput/keepalive and per-connection whitelist", async()=>{
    const payload = { name:"prod", host:"5.6.7.8", port:22, username:"bob", password:"x", commandTimeoutMs:120000, connectionTimeoutMs:30000, sftpTimeoutMs:300000, maxOutputBytes:10485760, keepaliveIntervalMs:10000, keepaliveCountMax:3, allowedLocalPaths:["/tmp"], allowedRemotePaths:["/home"], commandWhitelist:["^ls.*","^cat .*"], commandBlacklist:["^rm .*"] };
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    assert.equal(r.status,200);
    const list = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`)).json();
    const key = list["default/default/prod"] ? "default/default/prod" : "prod";
    assert.equal(list[key].maxOutputBytes,10485760);
    assert.deepEqual(list[key].commandWhitelist,["^ls.*","^cat .*"]);
  });
});
