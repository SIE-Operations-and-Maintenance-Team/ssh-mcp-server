import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandLineParser } from "../build/cli/command-line-parser.js";

describe("cli hierarchy", () => {
  it("single host args go to default/default/default", () => {
    const cfg = CommandLineParser.parse(["--host","1.1.1.1","--username","root","--password","x"]);
    assert.equal(cfg.projects.default.environments.default.hosts.default.host, "1.1.1.1");
    assert.equal(cfg.projects.default.displayName, "默认项目");
  });
  it("legacy connections file migrates to default/default", async () => {
    const raw = { connections: { h1: { name:"h1", host:"2.2.2.2", port:22, username:"u" } } };
    const migrated = CommandLineParser.migrateLegacy(raw);
    assert.ok(migrated.projects.default.environments.default.hosts.h1);
  });
});
