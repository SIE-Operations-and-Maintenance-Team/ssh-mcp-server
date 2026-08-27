import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getGlobalConfigPath, ConfigStore } from "../build/services/config-store.js";

describe("config-store", () => {
  it("should resolve global path and load empty when file missing", async () => {
    const p = getGlobalConfigPath();
    assert.match(p, /config\.json$/);
  });

  it("should respect SSH_MCP_CONFIG env override", async () => {
    const prev = process.env.SSH_MCP_CONFIG;
    process.env.SSH_MCP_CONFIG = "/tmp/custom-config.json";
    const p = getGlobalConfigPath();
    assert.equal(path.resolve("/tmp/custom-config.json"), p);
    if (prev === undefined) delete process.env.SSH_MCP_CONFIG;
    else process.env.SSH_MCP_CONFIG = prev;
  });

  it("should atomically save and reload", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-test-"));
    const configPath = path.join(tmpDir, "config.json");
    const store = new ConfigStore({ configPath });
    await store.save({ port: 61823, projects: {} });
    const loaded = await store.load();
    assert.equal(loaded.port, 61823);
    assert.deepEqual(loaded.projects, {});
    const files = await fs.readdir(tmpDir);
    assert.ok(files.includes("config.json"));
    assert.ok(!files.includes("config.json.tmp"));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should merge patch and validate port range", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-test-"));
    const configPath = path.join(tmpDir, "config.json");
    const store = new ConfigStore({ configPath });
    await store.save({ port: 61823, projects: {} });
    await assert.rejects(() => store.save({ port: 99999 }), /port out of range|Too big|65535/);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return default when file missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-test-"));
    const configPath = path.join(tmpDir, "missing.json");
    const store = new ConfigStore({ configPath });
    const loaded = await store.load();
    assert.equal(loaded.port, 61823);
    assert.deepEqual(loaded.projects, {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
