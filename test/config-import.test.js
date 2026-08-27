import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises"; import path from "node:path"; import os from "node:os";
describe("config import via projects hierarchy", ()=>{
  it("should accept array format import", async()=>{
    const { CommandLineParser } = await import("../build/cli/command-line-parser.js");
    const cfg = [{ name:"dev", host:"1.2.3.4", port:22, username:"alice", password:"x" }];
    for(const c of cfg){
      const n = CommandLineParser.normalizeConfig(c);
      assert.equal(n.host,"1.2.3.4");
    }
  });
  it("should export flat and import roundtrip (hierarchy)", async()=>{
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"ssh-mcp-import-"));
    const cfgPath = path.join(tmp,"config.json");
    const { startAdminServer } = await import("../build/server/index.js");
    const srv = await startAdminServer({ port:0, configPath: cfgPath });
    try{
      const payload = { name:"imp-test", host:"10.0.0.1", port:22, username:"bob", password:"secret123" };
      const r1 = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      assert.equal(r1.status,200);
      const exp = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/config/export`)).json();
      // export returns projects + flat connections derived from hierarchy
      // imp-test lives under default/default, flat key is default/default/imp-test
      assert.ok(exp.projects.default.environments.default.hosts["imp-test"]);
      assert.equal(exp.projects.default.environments.default.hosts["imp-test"].password,"secret123");
      assert.equal(exp.connections["default/default/imp-test"].password,"secret123");
      // import as new via connections (legacy) -> goes to default/default
      const imp = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/config/import`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ connections:[{ name:"imp2", host:"10.0.0.2", port:22, username:"alice", password:"x" }] })})).json();
      assert.equal(imp.ok,true);
      const list = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`)).json();
      assert.ok(list["default/default/imp2"]);
      // also verify via export projects
      const exp2 = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/config/export`)).json();
      assert.ok(exp2.projects.default.environments.default.hosts["imp2"]);
      // import via projects hierarchy
      const impPayload = { projects:{ extra:{ displayName:"Extra", environments:{ staging:{ displayName:"Staging", hosts:{ hostA:{ name:"hostA", host:"10.1.1.1", port:22, username:"u", password:"p" } } } } } } };
      const impProj = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/config/import`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(impPayload)})).json();
      assert.equal(impProj.ok,true);
      const projDetail = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/projects/extra`)).json();
      assert.ok(projDetail.environments.staging.hosts["hostA"]);
    } finally{ await srv.close(); try{ await fs.rm(tmp,{recursive:true,force:true}); }catch{} }
  });
});
