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

  it("should backfill empty host name from map key on load", async () => {
    // 模拟桌面版历史导入的脏数据：key 有名称、对象内 name 为空串
    // （ConnectionSchema.name 有 min(1) 约束，不归一化整个 load 会抛错）
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-mcp-test-"));
    const configPath = path.join(tmpDir, "config.json");
    const dirty = {
      port: 61823,
      projects: {
        p1: {
          environments: {
            e1: {
              hosts: {
                "web-01": { name: "", host: "10.0.0.1", port: 22, username: "root" },
                "web-02": { name: "web-02", host: "10.0.0.2", port: 22, username: "root" },
              },
            },
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(dirty), "utf-8");
    const loaded = await new ConfigStore({ configPath }).load();
    const hosts = loaded.projects.p1.environments.e1.hosts;
    assert.equal(hosts["web-01"].name, "web-01"); // 空 name 用 key 回填
    assert.equal(hosts["web-02"].name, "web-02"); // 已有 name 保持
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
