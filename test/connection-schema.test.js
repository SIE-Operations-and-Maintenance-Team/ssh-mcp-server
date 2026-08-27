import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("connection-schema full fields", ()=>{
  it("should accept proxy/transportMode/commandTemplate/pty/timeouts and reject bad regex", async()=>{
    const { ConnectionSchema } = await import("../build/models/admin-types.js");
    const ok = ConnectionSchema.passthrough().parse({
      name:"dev", host:"1.2.3.4", port:22, username:"alice",
      proxy:"socks5://127.0.0.1:1080",
      transportMode:"shell",
      shellReadyTimeoutMs:15000,
      commandTemplate:"su root -c <quotedCommand>",
      pty:false,
      commandTimeoutMs:120000,
      maxOutputBytes: 10485760,
      keepaliveIntervalMs:10000,
      keepaliveCountMax:3
    });
    assert.equal(ok.transportMode,"shell");
    assert.equal(ok.pty,false);
    // 非法正则应抛
    assert.throws(()=> ConnectionSchema.parse({ name:"x", host:"h", port:22, username:"u", commandWhitelist:["[bad"] }));
  });
  it("should validate allowedRemotePaths must be absolute POSIX", async()=>{
    const { ConnectionSchema } = await import("../build/models/admin-types.js");
    assert.throws(()=> ConnectionSchema.parse({ name:"x", host:"h", port:22, username:"u", allowedRemotePaths:["relative/path"] }));
  });
});
