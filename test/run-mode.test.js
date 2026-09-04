import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRunMode, parseAdminPort } from "../build/cli/run-mode.js";

describe("run-mode", () => {
  it("defaults to proxy mode when no args are given (npx form)", () => {
    assert.equal(resolveRunMode([]).mode, "proxy");
  });

  it("routes --admin to admin mode", () => {
    assert.equal(resolveRunMode(["--admin"]).mode, "admin");
    assert.equal(resolveRunMode(["--admin", "--admin-port", "7000"]).adminPort, 7000);
  });

  it("routes --stdio to legacy stdio mode", () => {
    assert.equal(resolveRunMode(["--stdio"]).mode, "stdio");
  });

  it("routes SSH config args to legacy stdio mode", () => {
    for (const argv of [
      ["--config-file", "cfg.json"],
      ["-h", "1.2.3.4", "-p", "22", "-u", "root", "-w", "pwd"],
      ["--host", "srv", "--username", "root"],
      ["--ssh", '{"host":"srv"}'],
      ["--transport-mode", "shell"],
      ["--pre-connect"],
      ["-W", "ls,cat"],
      ["--proxy", "socks5://127.0.0.1:1080"],
    ]) {
      assert.equal(resolveRunMode(argv).mode, "stdio", `argv=${JSON.stringify(argv)}`);
    }
  });

  it("keeps proxy mode for bare --admin-port override", () => {
    const mode = resolveRunMode(["--admin-port", "7000"]);
    assert.equal(mode.mode, "proxy");
    assert.equal(mode.adminPort, 7000);
  });

  it("rejects invalid --admin-port values", () => {
    assert.equal(parseAdminPort(["--admin-port", "abc"]), undefined);
    assert.equal(parseAdminPort(["--admin-port", "0"]), undefined);
    assert.equal(parseAdminPort(["--admin-port", "70000"]), undefined);
    assert.equal(parseAdminPort(["--admin-port"]), undefined);
  });
});
