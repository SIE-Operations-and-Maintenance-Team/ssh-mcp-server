import type { FastifyInstance } from "fastify";
import { DEFAULT_ADMIN_PORT } from "../../models/admin-types.js";
import type { ConfigStore } from "../../services/config-store.js";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import {
  isAutostartSupported,
  getAutostartEnabled,
  setAutostart,
} from "../../services/autostart-service.js";
import {
  getCurrentVersion,
  getUpdateStatus,
  checkForUpdate,
  installLatest,
} from "../../services/update-service.js";
import { scheduleRestartAndExit } from "../../services/restart-helper.js";

export function registerSystemRoutes(
  app: FastifyInstance,
  store: ConfigStore,
  hooks: { onRestart?: () => Promise<number> } = {},
) {
  app.get("/admin/api/system/info", async () => {
    // 已在 index.ts 注册，此处为冗余兼容
    const addr = app.server.address() as any;
    const cfg = await store.load();
    const port = addr && typeof addr.port === "number" ? addr.port : cfg.port;
    return { port, version: getCurrentVersion(), platform: process.platform, configPath: store.path };
  });

  // R5: 注册 MCP 到指定 scope 的 mcp.json
  app.post("/admin/api/system/register-mcp", async (req: any) => {
    const { client = "claude", scope = "user", serverName = "ssh-mcp-server", port, force = false } = (req.body as any) || {};
    // client 直接拼进 home 目录文件名，必须限定字符集防路径穿越
    const safeNameRe = /^[a-zA-Z0-9_-]{1,32}$/;
    if (!safeNameRe.test(client)) {
      return { ok: false, code: "INVALID_CLIENT", message: "client 仅允许字母、数字、_、-（1-32 字符）", retriable: false };
    }
    if (!safeNameRe.test(serverName)) {
      return { ok: false, code: "INVALID_SERVER_NAME", message: "serverName 仅允许字母、数字、_、-（1-32 字符）", retriable: false };
    }
    const cfg = await store.load();
    const actualPort = port ?? cfg.port ?? DEFAULT_ADMIN_PORT;
    // 纯 http 条目：避免同时含 command 导致客户端再拉起一个 --admin-port 进程与当前服务抢端口
    const mcpEntry = { type: "http", url: `http://127.0.0.1:${actualPort}/mcp` };
    let target = "";
    let conflict = false;
    if (client === "claude") {
      // Muse: ~/.claude.json (user) 或 ./.claude.json (project)
      target = scope === "project" ? path.join(process.cwd(), ".claude.json") : path.join(os.homedir(), ".claude.json");
    } else if (client === "vscode") {
      target = path.join(os.homedir(), ".vscode", "mcp.json");
    } else {
      target = path.join(os.homedir(), `.${client}-mcp.json`);
    }
    try {
      const raw = await fs.readFile(target, "utf-8");
      const j = JSON.parse(raw);
      const existing = j.mcpServers?.[serverName] || j.servers?.[serverName];
      if (existing && !force) conflict = true;
      if (!conflict || force) {
        j.mcpServers = j.mcpServers || j.servers || {};
        if (j.servers && !j.mcpServers) j.mcpServers = j.servers;
        j.mcpServers[serverName] = mcpEntry;
        if (j.servers) j.servers = j.mcpServers;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(j, null, 2), "utf-8");
      }
    } catch (e: any) {
      if (e.code === "ENOENT") {
        const j: any = { mcpServers: { [serverName]: mcpEntry } };
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(j, null, 2), "utf-8");
      } else if (e instanceof SyntaxError) {
        return { ok: false, code: "PARSE_ERROR", message: "target json parse failed", retriable: false };
      } else throw e;
    }
    return { ok: true, path: target, conflict };
  });

  // ===== 登录自启动（HKCU Run 注册表键）=====
  app.get("/admin/api/autostart", async () => {
    return {
      enabled: await getAutostartEnabled(),
      supported: isAutostartSupported(),
    };
  });

  app.put("/admin/api/autostart", async (req: any, reply: any) => {
    if (!isAutostartSupported()) {
      reply.code(400);
      return { ok: false, code: "UNSUPPORTED_PLATFORM", message: "登录自启动仅支持 Windows" };
    }
    try {
      const enabled = Boolean((req.body || {}).enabled);
      const actual = await setAutostart(enabled);
      return { ok: true, enabled: actual, supported: true };
    } catch (e: any) {
      reply.code(500);
      return { ok: false, code: "AUTOSTART_FAILED", message: String(e?.message || e) };
    }
  });

  // ===== 应用更新（对照 npm registry latest）=====
  app.get("/admin/api/update/status", async () => {
    return { currentVersion: getCurrentVersion(), ...getUpdateStatus() };
  });

  app.post("/admin/api/update/check", async () => {
    return await checkForUpdate();
  });

  app.post("/admin/api/update/apply", async (req: any, reply: any) => {
    const status = getUpdateStatus();
    if (!status.installed) {
      reply.code(400);
      return { ok: false, code: "DEV_MODE", message: "当前为本地开发模式运行（非 npm 安装），无法在线更新" };
    }
    if (!status.checked || (!status.hasUpdate && !status.targetVersion)) {
      reply.code(400);
      return { ok: false, code: "NO_UPDATE_INFO", message: "请先检查更新" };
    }
    reply.send({ applying: true });
    setImmediate(async () => {
      try {
        await installLatest();
      } catch {
        return; // 失败原因已写入 update 状态，status 接口可见
      }
      scheduleRestartAndExit(() => app.close());
    });
  });

  // ===== 应用控制（重启服务）=====
  app.post("/admin/api/restart", async (_req: any, reply: any) => {
    reply.send({ restarting: true });
    setImmediate(async () => {
      try {
        if (hooks.onRestart) {
          // 同进程软重启：关闭旧实例后以最新配置重建（含端口变更）
          await hooks.onRestart();
        } else {
          // 兜底：进程外拉起（无 onRestart 钩子的调用方）
          scheduleRestartAndExit(() => app.close());
        }
      } catch {
        scheduleRestartAndExit(() => app.close());
      }
    });
  });
}
