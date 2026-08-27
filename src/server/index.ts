import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ADMIN_PORT } from "../models/admin-types.js";
import { ConfigStore } from "../services/config-store.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { BackupService } from "../services/backup-service.js";
import { startBackupScheduler, stopBackupScheduler } from "../services/backup-scheduler.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

export interface StartAdminServerOptions {
  port?: number;
  configPath?: string;
}

async function createServerInstance(opts: StartAdminServerOptions = {}, onRestart: () => Promise<number>) {
  const store = new ConfigStore({ configPath: opts.configPath });
  const cfg = await store.load();
  const port = opts.port ?? cfg.port ?? DEFAULT_ADMIN_PORT;

  const app = Fastify({ logger: false });

  // 仅信任本地回环 Host 头：接口无鉴权，靠该校验阻断网页经 DNS rebinding 读配置/调 /mcp
  const trustedHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  app.addHook("onRequest", async (req, reply) => {
    const raw = String(req.headers.host || "").toLowerCase();
    let hostname = raw;
    if (hostname.startsWith("[")) {
      const end = hostname.indexOf("]");
      hostname = end > 0 ? hostname.slice(0, end + 1) : hostname;
    } else {
      const idx = hostname.lastIndexOf(":");
      if (idx > 0) hostname = hostname.slice(0, idx);
    }
    if (!trustedHosts.has(hostname)) {
      return reply.code(403).send({ ok: false, code: "HOST_FORBIDDEN", message: "不允许的 Host 头" });
    }
  });

  registerAdminRoutes(app, store);
  registerSettingsRoutes(app, store);
  registerAuditRoutes(app);
  registerBackupRoutes(app, store);
  // 同进程软重启：不依赖外部拉起进程（沙箱/服务/终端环境均可靠），由外层 holder 负责先关旧实例
  registerSystemRoutes(app, store, { onRestart });

  // HTTP /mcp 与 stdio 共用 SSHConnectionManager 单例：启动即加载 UI 配置，
  // 配置文件变更时热同步（仅 projects/security 变化才重置，避免改端口等误断开所有连接）
  const sshManager = SSHConnectionManager.getInstance();
  let mcpConfigSig: string | null = null;
  const applyMcpConfig = (c: any) => {
    const sig = JSON.stringify({ projects: c.projects, security: c.security });
    if (sig === mcpConfigSig) return;
    mcpConfigSig = sig;
    sshManager.setConfig(c);
    if (c?.preConnect) {
      void sshManager.connectAll().catch(() => {});
    }
  };
  applyMcpConfig(cfg);
  // 独立于备份调度器的配置 watcher：UI 保存配置后 HTTP /mcp 即时生效
  const stopMcpWatch = store.onChange((nextCfg: any) => {
    try { applyMcpConfig(nextCfg); } catch {}
  });

  await registerMcpRoutes(app);

  // R6/R7: 静态托管 admin-web/dist 于 /admin/ （同端口）
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(__dirname, "../../admin-web/dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic as any, { root: dist, prefix: "/admin/" });
    // SPA fallback: /admin -> index.html (fastifyStatic 已处理 /admin/，此处补 /admin 无斜杠)
    app.get("/admin", async (_req, reply) => reply.sendFile("index.html"));
    // 根路径直接跳转管理界面，避免裸 / 404
    app.get("/", async (_req, reply) => reply.redirect("/admin/"));
  }

  await app.listen({ host: "127.0.0.1", port });
  const addr = app.server.address() as any;
  const actualPort = addr.port;
  // 定时备份调度
  let stopWatch: (() => void) | null = null;
  try {
    const svc = new BackupService(store);
    startBackupScheduler(store, svc, cfg);
    // 配置变更时重调度（热重载）
    stopWatch = store.onChange((nextCfg: any) => {
      try { startBackupScheduler(store, svc, nextCfg); } catch {}
    });
  } catch {}
  return {
    port: actualPort,
    close: async () => { try { stopBackupScheduler(); } catch {} try { stopWatch?.(); } catch {} try { stopMcpWatch(); } catch {} return app.close(); },
    app,
  };
}

export async function startAdminServer(opts: StartAdminServerOptions = {}) {
  // 重启 = 关闭当前实例（释放端口、停调度器/watcher）→ 以最新配置重建并监听
  const holder: { current?: Awaited<ReturnType<typeof createServerInstance>> } = {};
  const onRestart = async (): Promise<number> => {
    if (holder.current) await holder.current.close();
    const next = await createServerInstance(opts, onRestart);
    holder.current = next;
    return next.port;
  };
  holder.current = await createServerInstance(opts, onRestart);
  return {
    get port() { return holder.current!.port; },
    get app() { return holder.current!.app; },
    close: async () => holder.current!.close(),
  };
}
