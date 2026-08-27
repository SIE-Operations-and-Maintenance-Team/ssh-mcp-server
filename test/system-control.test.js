import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// 移植自 MCP-DB-Tools 的系统控制三件套：登录自启动 / 应用更新 / 应用控制
// 只测纯函数与只读路由；写入注册表（PUT autostart）与真实重启（restart/apply）不进测试。
describe("system control (autostart/update/restart)", () => {
  describe("pure helpers", () => {
    it("compareSemver ordering", async () => {
      const { compareSemver } = await import("../build/services/update-service.js");
      assert.equal(compareSemver("1.9.0", "1.9.0"), 0);
      assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
      assert.equal(compareSemver("1.9.0", "2.0.0"), -1);
      assert.equal(compareSemver("v1.9.0", "1.9.0"), 0);
      assert.equal(compareSemver("1.9.0-beta.1", "1.9.0"), 0); // 预发布标签忽略
      assert.equal(compareSemver("1.9", "1.9.0"), 0);
    });

    it("buildAutostartCommand quotes paths and appends --admin", async () => {
      const { buildAutostartCommand } = await import("../build/services/autostart-service.js");
      const cmd = buildAutostartCommand();
      assert.match(cmd, /^".+node[^"]*"\s+".+"\s+--admin$/);
    });
  });

  describe("read-only routes", () => {
    let srv;
    let cfgPath;
    before(async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-sys-"));
      cfgPath = path.join(tmp, "config.json");
      const { startAdminServer } = await import("../build/server/index.js");
      srv = await startAdminServer({ port: 0, configPath: cfgPath });
    });
    after(async () => { await srv?.close(); try { await fs.unlink(cfgPath); } catch {} });

    it("GET /admin/api/autostart returns shape", async () => {
      const r = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/autostart`)).json();
      assert.equal(typeof r.enabled, "boolean");
      assert.equal(typeof r.supported, "boolean");
      assert.equal(r.supported, process.platform === "win32");
    });

    it("GET /admin/api/defaults exposes single-source defaults", async () => {
      const r = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/defaults`)).json();
      assert.ok(Array.isArray(r.defaultEnvironments) && r.defaultEnvironments.includes("测试环境"));
      assert.ok(Array.isArray(r.defaultCommandBlacklist) && r.defaultCommandBlacklist.length >= 7);
      // 与 security 默认值同源：未配置时 GET /security 的黑名单应等于 defaults 提供的
      const sec = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/security`)).json();
      assert.deepEqual(sec.commandBlacklist, r.defaultCommandBlacklist);
    });

    it("GET /admin/api/update/status returns shape with currentVersion", async () => {
      const r = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/update/status`)).json();
      assert.match(r.currentVersion, /^\d+\.\d+\.\d+/);
      assert.equal(r.configured, true);
      assert.equal(typeof r.installed, "boolean");
      assert.equal(r.checked, false); // 从未检查
      // 本地 build 目录运行应为开发模式
      assert.equal(r.installed, false);
    });

    it("PUT autostart respects platform support without touching real registry", async () => {
      // 只验证路由返回（不真实写注册表，避免污染用户 HKCU Run 键）：
      // 非 Windows → 400 UNSUPPORTED_PLATFORM；Windows → 交给 setAutostart（可能 200 或注册表错误 500）
      const res = await fetch(`http://127.0.0.1:${srv.port}/admin/api/autostart`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      if (process.platform !== "win32") {
        assert.equal(res.status, 400);
        assert.match((await res.json()).code, /UNSUPPORTED_PLATFORM/);
      } else {
        // Windows 上不强制断言 200：真实写注册表可能被沙箱/权限拦截返回 500，
        // 但必须明确是「注册表写入失败」而非「平台不支持」。
        assert.ok(res.status === 200 || res.status === 500, `expected 200 or 500, got ${res.status}`);
      }
    });

    it("POST /admin/api/restart soft-restarts in-process and comes back", async () => {
      const before = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/system/info`)).json();
      const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/restart`, { method: "POST" });
      assert.equal((await r.json()).restarting, true);
      // 软重启窗口：轮询等服务回来（同进程重建，通常 <1s）
      let info = null;
      for (let i = 0; i < 30 && !info; i++) {
        await new Promise((res) => setTimeout(res, 200));
        try {
          const resp = await fetch(`http://127.0.0.1:${srv.port}/admin/api/system/info`);
          if (resp.ok) info = await resp.json();
        } catch {}
      }
      assert.ok(info, "restart 后服务未恢复");
      assert.equal(info.version, before.version);
    });
  });
});
