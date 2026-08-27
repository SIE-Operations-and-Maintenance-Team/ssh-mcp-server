import type { FastifyInstance } from "fastify";
import { ConfigStore } from "../../services/config-store.js";
import { BackupService } from "../../services/backup-service.js";

export function registerBackupRoutes(app: FastifyInstance, store: ConfigStore) {
  const svc = new BackupService(store);
  app.get("/admin/api/backups", async () => svc.list());
  app.post("/admin/api/backups/snapshot", async () => svc.snapshot());
  app.post("/admin/api/backups/restore/:id", async (req: any) => {
    await svc.restore(req.params.id);
    return { ok: true };
  });
}
