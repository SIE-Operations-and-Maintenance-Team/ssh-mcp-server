import type { FastifyInstance } from "fastify";
import { ConfigStore } from "../../services/config-store.js";
import { DEFAULT_ADMIN_PORT } from "../../models/admin-types.js";
import { SettingsSchema } from "../../models/admin-types.js";
import { BackupService } from "../../services/backup-service.js";
import { rescheduleBackupScheduler } from "../../services/backup-scheduler.js";
import { globalAuditStore } from "../../services/audit-store.js";

export function registerSettingsRoutes(app: FastifyInstance, store: ConfigStore) {
  app.get("/admin/api/settings", async () => {
    const cfg: any = await store.load();
    return {
      port: cfg.port ?? DEFAULT_ADMIN_PORT,
      preConnect: cfg.preConnect ?? false,
      audit: cfg.audit ?? { enabled: true, retentionDays: 30, logResults: true },
      backups: cfg.backups ?? { retentionDays: 30, maxCount: 20, autoEnabled: false, intervalHours: 24 },
    };
  });

  app.post("/admin/api/settings", async (req, reply) => {
    const body: any = req.body || {};
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, code: "INVALID_SETTINGS", message: parsed.error.message };
    }
    if (parsed.data.port !== undefined && (parsed.data.port < 1 || parsed.data.port > 65535)) {
      reply.code(400);
      return { ok: false, code: "INVALID_PORT", message: "port out of range" };
    }
    const cfg: any = await store.load();
    const next: any = { ...cfg };
    if (parsed.data.port !== undefined) next.port = parsed.data.port;
    if (parsed.data.preConnect !== undefined) next.preConnect = parsed.data.preConnect;
    if (parsed.data.audit) next.audit = { ...(cfg.audit || {}), ...parsed.data.audit };
    if (parsed.data.backups) next.backups = { ...(cfg.backups || {}), ...parsed.data.backups };
    await store.save(next);
    // 审计保留天数即时生效（无需等配置 watcher 触发 setConfig）
    if (next.audit?.retentionDays) globalAuditStore.retentionDays = next.audit.retentionDays;
    try { rescheduleBackupScheduler(store, new BackupService(store), next); } catch {}
    return { ok: true, restartRequired: parsed.data.port !== undefined && parsed.data.port !== cfg.port };
  });
}
