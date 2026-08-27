import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SSHConnectionManager } from "../build/services/ssh-connection-manager.js";
import { ToolError } from "../build/utils/tool-error.js";

describe("SSHConnectionManager hierarchy flatName", () => {
  const manager = SSHConnectionManager.getInstance();

  afterEach(() => {
    manager.disconnect();
  });

  it("resolves full path (ops/prod/web-01)", () => {
    const cfg = {
      port: 61823,
      projects: {
        ops: {
          environments: {
            prod: {
              hosts: {
                "web-01": { host: "10.0.0.1", port: 22, username: "root", password: "pass" },
              },
            },
          },
        },
      },
    };
    manager.setConfig(cfg);
    const c = manager.getConfig("ops/prod/web-01");
    assert.equal(c.host, "10.0.0.1");
    // also via getAllServerInfos flatName
    const infos = manager.getAllServerInfos();
    assert.equal(infos.length, 1);
    assert.equal(infos[0].name, "ops/prod/web-01");
    assert.equal(infos[0].project, "ops");
    assert.equal(infos[0].environment, "prod");
    assert.equal(infos[0].hostName, "web-01");
  });

  it("reports ambiguous single host (p1 prod/h1 + test/h1 throws AMBIGUOUS_HOST)", () => {
    const cfg = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            prod: { hosts: { h1: { host: "1.1.1.1", port: 22, username: "u", password: "p" } } },
            test: { hosts: { h1: { host: "2.2.2.2", port: 22, username: "u", password: "p" } } },
          },
        },
      },
    };
    manager.setConfig(cfg);
    assert.throws(
      () => manager.getConfig("h1"),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, "AMBIGUOUS_HOST");
        return true;
      },
    );
  });

  it("resolves single host uniquely", () => {
    const cfg = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            prod: { hosts: { h1: { host: "1.1.1.1", port: 22, username: "u", password: "p" } } },
          },
        },
      },
    };
    manager.setConfig(cfg);
    const c1 = manager.getConfig("h1");
    assert.equal(c1.host, "1.1.1.1");
    const c2 = manager.getConfig("p1/prod/h1");
    assert.equal(c2.host, "1.1.1.1");
    // default without name should be first flatName
    const c3 = manager.getConfig();
    assert.equal(c3.host, "1.1.1.1");
  });

  it("merges global security as fallback (blacklist union)", () => {
    const cfg = {
      port: 61823,
      security: {
        commandWhitelist: ["^ls.*"],
        commandBlacklist: ["^rm.*"],
        allowedLocalPaths: ["/tmp"],
        allowedRemotePaths: ["/var/log"],
      },
      projects: {
        p: {
          environments: {
            e: {
              hosts: {
                // 只配了连接级黑名单：应与全局黑名单取并集
                custom: { host: "1.1.1.1", port: 22, username: "u", commandBlacklist: ["^custom.*"] },
                // 全留空：应完整跟随全局
                plain: { host: "2.2.2.2", port: 22, username: "u" },
                // 白名单/路径配了连接级：以连接级为准不被全局覆盖
                own: { host: "3.3.3.3", port: 22, username: "u", commandWhitelist: ["^echo.*"], allowedRemotePaths: ["/data"] },
              },
            },
          },
        },
      },
    };
    manager.setConfig(cfg);
    const custom = manager.getConfig("p/e/custom");
    assert.deepEqual(custom.commandBlacklist, ["^rm.*", "^custom.*"]);
    assert.deepEqual(custom.commandWhitelist, ["^ls.*"]);
    assert.deepEqual(custom.allowedRemotePaths, ["/var/log"]);
    const plain = manager.getConfig("p/e/plain");
    assert.deepEqual(plain.commandWhitelist, ["^ls.*"]);
    assert.deepEqual(plain.commandBlacklist, ["^rm.*"]);
    assert.deepEqual(plain.allowedLocalPaths, ["/tmp"]);
    const own = manager.getConfig("p/e/own");
    assert.deepEqual(own.commandWhitelist, ["^echo.*"]);
    assert.deepEqual(own.allowedRemotePaths, ["/data"]);
    assert.deepEqual(own.commandBlacklist, ["^rm.*"]);
    // 合并不得污染存储层原始配置
    assert.deepEqual(cfg.projects.p.environments.e.hosts.custom.commandBlacklist, ["^custom.*"]);
  });
});
