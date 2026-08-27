import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("admin server", () => {
  it("should listen on 127.0.0.1 and expose /admin/api/connections", async () => {
    const { startAdminServer } = await import("../build/server/index.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-srv-"));
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ port: 0, projects: { default: { displayName: "默认项目", environments: { default: { displayName: "默认环境", hosts: { demo: { name: "demo", host: "1.1.1.1", port: 22, username: "u" } } } } } } }), "utf-8");
    const srv = await startAdminServer({ port: 0, configPath });
    try {
      assert.ok(srv.port > 0 && srv.port < 65536);
      // Must bind 127.0.0.1 only - fetch via 127.0.0.1 should succeed
      const res = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body === "object");
    } finally {
      await srv.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should respect port priority and return system info", async () => {
    const { startAdminServer } = await import("../build/server/index.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-srv2-"));
    const configPath = path.join(tmpDir, "config.json");
    const srv = await startAdminServer({ port: 0, configPath });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/admin/api/system/info`);
      assert.equal(res.status, 200);
      const info = await res.json();
      assert.equal(info.port, srv.port);
    } finally {
      await srv.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
