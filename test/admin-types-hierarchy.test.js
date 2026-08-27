import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalConfigSchema } from "../build/models/admin-types.js";

describe("hierarchy validation", () => {
  it("accepts project name with special characters (naming restriction removed)", () => {
    const cfg = GlobalConfigSchema.parse({ projects: { "bad name": { environments: {} } } });
    assert.ok(cfg.projects["bad name"]);
  });
  it("rejects defaultEnvironment not in environments", () => {
    assert.throws(() => GlobalConfigSchema.parse({
      projects: { p1: { defaultEnvironment: "prod", environments: { dev: { hosts: {} } } } }
    }));
  });
  it("accepts valid 3-level config", () => {
    const cfg = GlobalConfigSchema.parse({
      projects: {
        ops: {
          displayName: "运维平台",
          defaultEnvironment: "prod",
          environments: {
            prod: { displayName: "生产", hosts: { "web-01": { name: "web-01", host: "10.0.0.1", port: 22, username: "root" } } },
            test: { hosts: {} }
          }
        }
      }
    });
    assert.equal(cfg.projects.ops.environments.prod.hosts["web-01"].host, "10.0.0.1");
  });
  it("defaults projects to empty object", () => {
    const cfg = GlobalConfigSchema.parse({});
    assert.deepEqual(cfg.projects, {});
  });
});
