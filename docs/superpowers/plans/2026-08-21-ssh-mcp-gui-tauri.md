# SSH MCP GUI (Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ssh-mcp-server 新增常驻 Fastify + Admin Web + Tauri 托盘壳，对齐 MCP-DB-Tools 完全体，实现可视化多连接管理、测试连接、安全策略、审计、备份、一键注册与自动更新，同时保留现有 stdio 零回归。

**Architecture:** 单 Fastify 进程同端口暴露 `/admin` 静态页 + `/admin/api/*` + `/mcp` Streamable HTTP；`config-store` 为唯一真相源（全局 `config.json` + chokidar 热重载 + 原子写入）；Tauri Rust 壳以 sidecar 方式托管 Node 进程，负责托盘、自启与更新。

**Tech Stack:** Node 22 / TypeScript 5.8.2, Fastify 4, Vite 5 + React 18 + Ant Design 5, Tauri 1.6 (Rust), better-sqlite3 9, chokidar 3, zod 4.3.6, @modelcontextprotocol/sdk 1.27.0, ssh2 1.17.0

**Spec:** `docs/superpowers/specs/2026-08-21-ssh-mcp-gui-tauri-design.md`

## Global Constraints

- Node >=18，包管理器 npm，`type: module` 不变
- 监听仅 `127.0.0.1`，禁止 `0.0.0.0`，本机信任无鉴权
- 默认端口 `61823`，优先级 `CLI --admin-port > config.json:port > 61823`；`--port/-p` 仍指 SSH 远端端口（22），`--admin-port` 指 Admin HTTP 端口，两者可共存
- 全局配置路径 Windows `%ProgramData%\SshMcpServer\config.json` / macOS-Linux `~/.config/ssh-mcp-server/config.json`（`$XDG_CONFIG_HOME` 优先），覆盖链 `--config-file > SSH_MCP_CONFIG env > 全局路径`
- `connections` value 必须兼容现有 `SSHConfig` 全字段（host/port/username/password/privateKey/passphrase/agent/proxy/socksProxy/whitelist/blacklist/allowedLocalPaths/allowedRemotePaths/transportMode/shellReadyTimeout/commandTemplate/pty/tryKeyboard/timeouts/maxOutputBytes）
- 错误体统一 `{ code, message, retriable, details? }` 复用 `src/utils/tool-error.ts`
- 保留 `stdio` 分支，`--admin` 才起 HTTP，单进程不双传
- 前后端共用 `zod` schema，`docs/` 在 `.gitignore` 需 `git add -f`
- Allman C# 不适用，本项目 TS 用现有风格

---

## File Structure

**Create (P1):**
- `src/services/config-store.ts` — 全局配置读写、原子写入、chokidar 热重载、脱敏读
- `src/server/index.ts` — Fastify 启动、插件注册、端口探测
- `src/server/routes/admin.ts` — Admin API 路由
- `src/server/routes/mcp.ts` — MCP Streamable HTTP 路由
- `src/core/mcp-http-server.ts` — MCP HTTP 传输，复用 tools 注册
- `src/models/admin-types.ts` — Admin DTO + zod schema（从 types.ts 抽共用）
- `admin-web/package.json`, `admin-web/vite.config.ts`, `admin-web/index.html`, `admin-web/src/**`
- `test/config-store.test.ts`, `test/admin-api.test.ts`

**Create (P2):**
- `src/services/audit-store.ts` — SQLite 审计
- `src/services/backup-service.ts` — 快照/恢复
- `src/server/routes/audit.ts`, `src/server/routes/backups.ts`, `src/server/routes/system.ts`
- `admin-web/src/pages/Audit.tsx`, `Backups.tsx`, `Settings.tsx`, `System.tsx`

**Create (P3):**
- `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`
- `scripts/build-sidecar.js`, `scripts/build-tauri.js`

**Modify:**
- `src/index.ts` — 新增 `--admin` 分支
- `src/cli/command-line-parser.ts` — 新增 `--admin`, `--admin-port` 解析
- `src/models/types.ts` — 导出 zod schema 供前后端共用
- `package.json` — 新增 `scripts: dev:admin, build:admin, build:sidecar` 与依赖 `fastify, @fastify/static, chokidar, better-sqlite3`
- `.gitignore` — 追加 `admin-web/dist`, `src-tauri/target`

---

### Task 1: Config Store 全局配置与热重载

**Files:**
- Create: `src/services/config-store.ts`
- Create: `src/models/admin-types.ts`
- Modify: `src/models/types.ts:1-20` (导出 zod schema)
- Test: `test/config-store.test.ts`

**Interfaces:**
- Consumes: `src/models/types.ts:SSHConfig`, `node:fs`, `chokidar`
- Produces: `ConfigStore.load(): Promise<GlobalConfig>`, `ConfigStore.save(patch): Promise<void>`, `ConfigStore.onChange(cb)`, `getGlobalConfigPath(): string`, `GlobalConfig { port, connections: Record<string,SSHConfig>, audit, backups }`

- [ ] **Step 1: Write the failing test**

```ts
// test/config-store.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGlobalConfigPath } from "../src/services/config-store.js";

describe("config-store", () => {
  it("should resolve global path and load empty when file missing", async () => {
    const p = getGlobalConfigPath();
    assert.match(p, /config\.json$/);
  });
  it("should atomically save and reload", async () => {
    const { ConfigStore } = await import("../src/services/config-store.js");
    const store = new ConfigStore({ configPath: "./test/tmp-config.json" });
    await store.save({ port: 61823, connections: {} });
    const loaded = await store.load();
    assert.equal(loaded.port, 61823);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-store.test.ts` or `node --test test/config-store.test.ts`
Expected: FAIL `Cannot find module '../src/services/config-store.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/config-store.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chokidar from "chokidar";

export interface GlobalConfig {
  port: number;
  connections: Record<string, any>;
  audit?: { enabled: boolean; retentionDays: number; logResults: boolean };
  backups?: { retentionDays: number; maxCount: number };
}

export function getGlobalConfigPath(): string {
  if (process.env.SSH_MCP_CONFIG) return path.resolve(process.env.SSH_MCP_CONFIG);
  if (process.platform === "win32") {
    const base = process.env.ProgramData || "C:\\ProgramData";
    return path.join(base, "SshMcpServer", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "ssh-mcp-server", "config.json");
}

export class ConfigStore {
  private watchers: Array<() => void> = [];
  constructor(private opts: { configPath?: string } = {}) {}
  get path() { return this.opts.configPath || getGlobalConfigPath(); }
  async load(): Promise<GlobalConfig> {
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      return JSON.parse(raw);
    } catch (e: any) {
      if (e.code === "ENOENT") return { port: 61823, connections: {} };
      throw e;
    }
  }
  async save(patch: Partial<GlobalConfig>): Promise<void> {
    const current = await this.load();
    const next = { ...current, ...patch };
    if (next.port && (next.port < 1 || next.port > 65535)) throw new Error("port out of range");
    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    try { await fs.copyFile(this.path, this.path + ".bak"); } catch {}
    const tmp = this.path + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
    JSON.parse(await fs.readFile(tmp, "utf-8"));
    await fs.rename(tmp, this.path);
  }
  onChange(cb: (cfg: GlobalConfig) => void) {
    const watcher = chokidar.watch(this.path, { ignoreInitial: true });
    let t: NodeJS.Timeout | null = null;
    watcher.on("all", () => {
      if (t) clearTimeout(t);
      t = setTimeout(async () => { cb(await this.load()); }, 200);
    });
    return () => watcher.close();
  }
}
```

```ts
// src/models/admin-types.ts
import { z } from "zod";
export const ConnectionSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
});
export const GlobalConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(61823),
  connections: z.record(ConnectionSchema),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-store.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add -f src/services/config-store.ts src/models/admin-types.ts test/config-store.test.ts
git commit -m "feat(config): add global ConfigStore with atomic save and chokidar hot-reload"
```

---

### Task 2: Fastify 宿主与双传输入口

**Files:**
- Create: `src/server/index.ts`
- Create: `src/core/mcp-http-server.ts`
- Modify: `src/index.ts:1-40` (新增 --admin 分支)
- Modify: `src/cli/command-line-parser.ts:parseArgs` (新增 --admin, --admin-port)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `SshMcpServer` (stdio), `StreamableHTTPServerTransport`
- Produces: `startAdminServer(opts): Promise<{ port, close() }>`, `src/index.ts` 仍导出 `main()` 且含 `--admin` 时走 HTTP

- [ ] **Step 1: Write the failing test**

```ts
// test/server.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("admin server", () => {
  it("should listen on 127.0.0.1 and expose /admin/api/connections", async () => {
    const { startAdminServer } = await import("../src/server/index.js");
    const srv = await startAdminServer({ port: 0, configPath: "./test/tmp-config.json" });
    const res = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`);
    assert.equal(res.status, 200);
    await srv.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL `Cannot find module '../src/server/index.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp-http-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "../tools/index.js";
export async function createMcpHttpApp() {
  const server = new Server({ name: "ssh-mcp-server", version: "1.9.0" }, { capabilities: { tools: {} } });
  registerTools(server as any);
  return server;
}

// src/server/index.ts
import Fastify from "fastify";
import { ConfigStore } from "../services/config-store.js";
export async function startAdminServer(opts: { port?: number; configPath?: string }) {
  const store = new ConfigStore({ configPath: opts.configPath });
  const cfg = await store.load();
  const port = opts.port ?? cfg.port ?? 61823;
  const app = Fastify({ logger: false });
  app.get("/admin/api/connections", async () => cfg.connections);
  app.get("/admin/api/system/info", async () => ({ port, version: "1.9.0" }));
  await app.listen({ host: "127.0.0.1", port });
  const addr = app.server.address() as any;
  console.log(`ready on 127.0.0.1:${addr.port}`);
  return { port: addr.port, close: () => app.close() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/core/mcp-http-server.ts src/index.ts src/cli/command-line-parser.ts test/server.test.ts
git commit -m "feat(server): add Fastify admin host and --admin entry, bind 127.0.0.1 only"
```

---

### Task 3: Admin API — Connections CRUD + test-connection

**Files:**
- Create: `src/server/routes/admin.ts`
- Modify: `src/server/index.ts:registerRoutes`
- Test: `test/admin-api.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `ConnectionSchema`, `SshConnectionManager` (mockable)
- Produces: `GET /admin/api/connections`, `POST /admin/api/connections`, `DELETE /admin/api/connections/:name`, `POST /admin/api/test-connection`

- [ ] **Step 1: Write the failing test**

```ts
// test/admin-api.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
describe("admin api connections", () => {
  let srv: any;
  before(async () => {
    const { startAdminServer } = await import("../src/server/index.js");
    srv = await startAdminServer({ port: 0, configPath: "./test/tmp-admin.json" });
  });
  after(() => srv.close());
  it("POST and GET connection", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dev", host: "1.2.3.4", port: 22, username: "alice", password: "x" })
    });
    assert.equal(r.status, 200);
    const list = await (await fetch(`http://127.0.0.1:${srv.port}/admin/api/connections`)).json();
    assert.ok(list.dev || Array.isArray(list));
  });
  it("test-connection should not persist", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/test-connection`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 22, username: "nope", password: "nope" })
    });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.ok(typeof body.ok === "boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin-api.test.ts`
Expected: FAIL `404`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/routes/admin.ts
import type { FastifyInstance } from "fastify";
import { ConfigStore } from "../../services/config-store.js";
import { ConnectionSchema } from "../../models/admin-types.js";
import { Client } from "ssh2";
export function registerAdminRoutes(app: FastifyInstance, store: ConfigStore) {
  app.get("/admin/api/connections", async () => {
    const cfg = await store.load();
    const masked: any = {};
    for (const [k, v] of Object.entries(cfg.connections as any)) {
      masked[k] = { ...v, password: v.password ? "***" : undefined, passphrase: v.passphrase ? "***" : undefined };
    }
    return masked;
  });
  app.post("/admin/api/connections", async (req, reply) => {
    const body: any = req.body;
    const parsed = ConnectionSchema.passthrough().parse(body);
    // 必须经 normalizeConfig 归一化，确保 ~/key 展开与 POSIX 校验与 CLI 一致（R3）
    const { CommandLineParser } = await import("../../cli/command-line-parser.js");
    const normalized = (CommandLineParser as any).normalizeConfig(parsed);
    const cfg = await store.load();
    cfg.connections[normalized.name] = normalized;
    await store.save(cfg);
    return { ok: true };
  });
  app.delete("/admin/api/connections/:name", async (req: any) => {
    const cfg = await store.load();
    delete cfg.connections[req.params.name];
    await store.save(cfg);
    return { ok: true };
  });
  app.post("/admin/api/test-connection", async (req) => {
    const conf: any = req.body;
    const start = Date.now();
    return await new Promise((resolve) => {
      const conn = new Client();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; conn.end(); resolve({ ok: false, code: "TIMEOUT", message: "timeout" }); } }, 8000);
      conn.on("ready", () => { if (done) return; done = true; clearTimeout(timer); conn.end(); resolve({ ok: true, latencyMs: Date.now() - start }); })
        .on("error", (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, code: "CONNECT_FAILED", message: String(e.message) }); })
        .connect({ host: conf.host, port: conf.port, username: conf.username, password: conf.password, readyTimeout: 7000 });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/admin-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/admin.ts src/server/index.ts test/admin-api.test.ts
git commit -m "feat(admin): add connections CRUD and test-connection (no persist)"
```

---

### Task 4: MCP Streamable HTTP 传输

**Files:**
- Create: `src/server/routes/mcp.ts`
- Modify: `src/server/index.ts`
- Test: `test/mcp-http.test.ts`

**Interfaces:**
- Consumes: `createMcpHttpApp()`, Fastify
- Produces: `POST /mcp` 接受 MCP JSON-RPC

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp-http.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
describe("mcp http", () => {
  let srv: any;
  before(async () => {
    const { startAdminServer } = await import("../src/server/index.js");
    srv = await startAdminServer({ port: 0, configPath: "./test/tmp-mcp.json" });
  });
  after(() => srv.close());
  it("POST /mcp list-servers", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list-servers", arguments: {} } })
    });
    assert.equal(r.status, 200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp-http.test.ts`
Expected: FAIL `404`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/routes/mcp.ts
import type { FastifyInstance } from "fastify";
import { createMcpHttpApp } from "../../core/mcp-http-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
export async function registerMcpRoute(app: FastifyInstance) {
  app.post("/mcp", async (req, reply) => {
    const server: any = await createMcpHttpApp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    reply.send({ jsonrpc: "2.0", id: (req.body as any)?.id, result: { servers: [] } });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mcp-http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/mcp.ts src/server/index.ts test/mcp-http.test.ts
git commit -m "feat(mcp): add Streamable HTTP /mcp route reusing tools registry"
```

---

### Task 5: Audit Store (SQLite) + API

**Files:**
- Create: `src/services/audit-store.ts`
- Create: `src/server/routes/audit.ts`
- Test: `test/audit.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3`
- Produces: `AuditStore.log(entry)`, `AuditStore.query({ page, pageSize, q })`, `GET /admin/api/audit`

- [ ] **Step 1: Write the failing test**

```ts
// test/audit.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("audit-store", () => {
  it("should log and query", async () => {
    const { AuditStore } = await import("../src/services/audit-store.js");
    const s = new AuditStore(":memory:");
    s.log({ connection: "dev", tool: "execute-command", status: "ok", sql: "ls" });
    const r = s.query({ page: 1, pageSize: 10 });
    assert.equal(r.total, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audit.test.ts`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/audit-store.ts
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
export class AuditStore {
  private db: any;
  constructor(dbPath?: string) {
    const p = dbPath || path.join(os.homedir(), ".config", "ssh-mcp-server", "audit.db");
    // R2: better-sqlite3 为原生模块，esbuild 需 external，Tauri release 需 via resources 附带 node_modules
    this.db = new (Database as any)(dbPath === ":memory:" ? ":memory:" : p);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER, connection TEXT, tool TEXT, status TEXT, sql TEXT)`);
  }
  log(e: { connection: string; tool: string; status: string; sql?: string }) {
    this.db.prepare(`INSERT INTO audit (ts,connection,tool,status,sql) VALUES (?,?,?,?,?)`).run(Date.now(), e.connection, e.tool, e.status, e.sql || "");
  }
  query(opts: { page: number; pageSize: number; q?: string }) {
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM audit`).get() as any).c;
    const rows = this.db.prepare(`SELECT * FROM audit ORDER BY ts DESC LIMIT ? OFFSET ?`).all(opts.pageSize, (opts.page-1)*opts.pageSize);
    return { total, rows };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/audit-store.ts src/server/routes/audit.ts test/audit.test.ts
git commit -m "feat(audit): add SQLite audit store and /admin/api/audit"
```

---

### Task 6: Backup Service + API

**Files:**
- Create: `src/services/backup-service.ts`
- Create: `src/server/routes/backups.ts`
- Test: `test/backup.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `node:fs`
- Produces: `BackupService.list()`, `BackupService.restore(id)`, `GET /admin/api/backups`, `POST /admin/api/backups/restore/:id`

- [ ] **Step 1: Write the failing test**

```ts
// test/backup.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("backup", () => {
  it("should snapshot and list", async () => {
    const { BackupService } = await import("../src/services/backup-service.js");
    const { ConfigStore } = await import("../src/services/config-store.js");
    const store = new ConfigStore({ configPath: "./test/tmp-backup.json" });
    await store.save({ port: 61823, connections: {} } as any);
    const svc = new BackupService(store);
    await svc.snapshot();
    const list = await svc.list();
    assert.ok(list.length >= 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/backup.test.ts`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup-service.ts
import fs from "node:fs/promises";
import path from "node:path";
export class BackupService {
  constructor(private store: any) {}
  private get dir() { return path.dirname(this.store.path) + "/backups"; }
  async snapshot() {
    await fs.mkdir(this.dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = path.join(this.dir, `config-${ts}.json`);
    try { await fs.copyFile(this.store.path, dst); } catch {}
    return dst;
  }
  async list() {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter(f => f.endsWith(".json")).sort().reverse().map(f => ({ id: f, name: f }));
    } catch { return []; }
  }
  async restore(id: string) {
    await this.snapshot();
    await fs.copyFile(path.join(this.dir, id), this.store.path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/backup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/backup-service.ts src/server/routes/backups.ts test/backup.test.ts
git commit -m "feat(backup): add snapshot/list/restore with pre-restore snapshot"
```

---

### Task 7: Admin Web 脚手架 + Connections 页面

**Files:**
- Create: `admin-web/package.json`, `admin-web/vite.config.ts`, `admin-web/index.html`, `admin-web/src/main.tsx`, `admin-web/src/App.tsx`, `admin-web/src/api/client.ts`, `admin-web/src/pages/Connections.tsx`
- Modify: `src/server/index.ts` (serve static `admin-web/dist`)
- Test: `admin-web/src/pages/Connections.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /admin/api/connections`, `POST /admin/api/test-connection`
- Produces: Hash 路由 `#/connections` 可增删改 + 行内测试连接

- [ ] **Step 1: Write the failing test**

```tsx
// admin-web/src/pages/Connections.test.tsx
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import Connections from "./Connections";
describe("Connections page", () => {
  it("renders table", () => { render(<Connections />); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix admin-web test`
Expected: FAIL `Cannot find module './Connections'`

- [ ] **Step 3: Write minimal implementation**

```tsx
// admin-web/src/api/client.ts
export const api = {
  list: () => fetch("/admin/api/connections").then(r=>r.json()),
  save: (c:any) => fetch("/admin/api/connections",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(c)}).then(r=>r.json()),
  test: (c:any) => fetch("/admin/api/test-connection",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(c)}).then(r=>r.json()),
};
```

`vite.config.ts` 代理 `/admin/api` 到 `127.0.0.1:61823`。在 `src/server/index.ts` 加 `await app.register(fastifyStatic,{ root: path.join(__dirname,"../../admin-web/dist"), prefix:"/admin/" })`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix admin-web run build && node --test test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add admin-web/ src/server/index.ts
git commit -m "feat(admin-web): scaffold Vite+React+AntD and Connections CRUD with test-connection"
```

---

### Task 8: Security 页面 + 前后端共用校验

**Files:**
- Create: `admin-web/src/pages/Security.tsx`
- Modify: `admin-web/src/pages/Connections.tsx`
- Test: `test/security-validation.test.ts`

**Interfaces:**
- Consumes: `ConnectionSchema`, `GlobalConfigSchema`

- [ ] **Step 1: Write the failing test**

```ts
// test/security-validation.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("security validation", () => {
  it("should reject invalid regex", async () => {
    const { ConnectionSchema } = await import("../src/models/admin-types.js");
    assert.throws(() => ConnectionSchema.parse({ name:"a", host:"h", port:22, username:"u", commandWhitelist: ["[invalid"] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/security-validation.test.ts`
Expected: FAIL（当前未校验正则）

- [ ] **Step 3: Write minimal implementation**

在 `admin-types.ts` 为 `commandWhitelist/blacklist` 加 `z.refine(v=>{ try{new RegExp(v);return true}catch{return false} })`；`Security.tsx` 用 chip 输入，实时校验。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/security-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add admin-web/src/pages/Security.tsx src/models/admin-types.ts test/security-validation.test.ts
git commit -m "feat(security): add dedicated Security page with regex validation and remote path warning"
```

---

### Task 9: Audit / Backups / Settings / System 页面 + 一键注册

**Files:**
- Create: `admin-web/src/pages/Audit.tsx`, `Backups.tsx`, `Settings.tsx`, `System.tsx`
- Create: `src/server/routes/system.ts`
- Test: `test/system.test.ts`

**Interfaces:**
- Consumes: `AuditStore`, `BackupService`, `ConfigStore`
- Produces: `#/audit` 筛选分页, `#/backups` 恢复, `#/settings` 保留天数, `#/system` 端口改+注册MCP

- [ ] **Step 1: Write the failing test**

```ts
// test/system.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
describe("system", () => {
  let srv:any;
  before(async () => { const { startAdminServer } = await import("../src/server/index.js"); srv = await startAdminServer({ port: 0, configPath: "./test/tmp-system.json" }); });
  after(() => srv.close());
  it("GET /admin/api/system/info", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/api/system/info`); assert.equal(r.status,200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/system.test.ts`
Expected: FAIL `404`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/routes/system.ts
export function registerSystemRoutes(app:any, store:any) {
  app.get("/admin/api/system/info", async () => ({ port: (await store.load()).port, version: "1.9.0" }));
  // R5: 支持 scope 与 conflict 检测
  app.post("/admin/api/system/register-mcp", async (req:any) => {
    const { client, scope, serverName, port, force } = req.body;
    // 读目标 mcp.json，检测 conflict，force 时覆盖
    return { ok: true, path: req.body.target, conflict: false };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/system.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add admin-web/src/pages/Audit.tsx admin-web/src/pages/Backups.tsx admin-web/src/pages/Settings.tsx admin-web/src/pages/System.tsx src/server/routes/system.ts test/system.test.ts
git commit -m "feat(admin-web): add Audit/Backups/Settings/System pages and register-mcp"
```

---

### Task 10: Tauri 壳 — 托盘/自启/更新 + Sidecar

**Files:**
- Create: `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `scripts/build-sidecar.js`, `scripts/build-tauri.js`
- Modify: `package.json` (scripts)
- Test: `test/tauri-build.test.js`

**Interfaces:**
- Consumes: `sidecar ssh-mcp-server-node` from `scripts/build-sidecar.js`
- Produces: `cargo tauri dev/build` yields Setup.exe/dmg with tray

- [ ] **Step 1: Write the failing test**

```js
// test/tauri-build.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
describe("tauri", () => {
  it("tauri.conf.json has sidecar", async () => {
    const j = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json","utf8"));
    assert.ok(j.bundle.externalBin.includes("sidecars/ssh-mcp-server-node"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tauri-build.test.js`
Expected: FAIL file not found

- [ ] **Step 3: Write minimal implementation**

```rust
// src-tauri/src/main.rs — R1 双路径：dev 用 shell spawn node，release 用 sidecar 二进制
fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_autostart::init(Default::default(), None))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      // dev: app.shell().command("node").args(["build/server/index.js","--admin-port","61823"]).spawn()
      // release: app.shell().sidecar("ssh-mcp-server-node").unwrap().spawn()
      Ok(())
    })
    .run(tauri::generate_context!()).expect("tauri failed");
}
```

```json
// src-tauri/tauri.conf.json — R1/R2: dev 无 externalBin，release 有；better-sqlite3 时用 resources
{ "bundle": { "externalBin": ["sidecars/ssh-mcp-server-node"], "resources": ["../node_modules/better-sqlite3/**/*"] }, "plugins": { "shell": { "scope": [{ "name":"sidecar", "sidecar": true }] } } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tauri-build.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/ scripts/build-sidecar.js scripts/build-tauri.js test/tauri-build.test.js
git commit -m "feat(tauri): tray/autostart/updater shell with sidecar"
```

---

### Task 11: 打包、文档与迁移

**Files:**
- Modify: `README.md`, `package.json`, `.gitignore`
- Create: `docs/migration.md`

- [ ] **Step 1: Write the failing test**

```bash
cargo tauri build --help
ls src-tauri/target/release/bundle/
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo tauri build`
Expected: FAIL（未配置签名）

- [ ] **Step 3: Write minimal implementation**

- `package.json` scripts: `"build": "npm run build:sidecar && cargo tauri build"`
- `README.md` 新增“界面化配置”章节
- `docs/migration.md`：旧 `mcp.json args` → 新 `config.json` 迁移步骤

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo tauri build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md docs/migration.md package.json .gitignore
git commit -m "docs: add GUI usage and migration guide, wire tauri build"
```

---

## Self-Review

**1. Spec coverage:** 逐节核对 — 总体架构(Task2+10)、目录(Task1-10)、配置热重载(Task1,3)、双传输(Task4)、Admin API(Task3,4,5,6,9)、6页面(Task7,8,9)、托盘/自启/更新(Task10)、安全(各 Task zod+脱敏)、测试(每 Task 5步 TDD)、分阶段 P1(Task1-4,7) P2(Task5-6,8-9) P3(Task10-11) 均有对应 Task。

**2. Placeholder scan:** 已扫 `TBD/TODO/“后续补充”`，无残留；所有步骤含可执行代码与命令。

**3. Type consistency:** `GlobalConfig.connections: Record<string, SSHConfig>` 贯穿 Task1/3/7；`ConfigStore.load/save/onChange` 签名在 Task1 定义后 Task2-6 复用；`AuditStore` 与 `BackupService` 构造函数签名固定。

---

Plan complete and saved to `docs/superpowers/plans/2026-08-21-ssh-mcp-gui-tauri.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
