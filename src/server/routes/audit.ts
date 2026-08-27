import type { FastifyInstance } from "fastify";
import { AuditStore, globalAuditStore } from "../../services/audit-store.js";

export function registerAuditRoutes(app: FastifyInstance, store: AuditStore = globalAuditStore) {
  app.get("/admin/api/audit", async (req: any) => {
    const { page = "1", pageSize = "20", q, connection, tool, status } = (req.query as any) || {};
    return store.query({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10), q, connection, tool, status });
  });
}

export { globalAuditStore as auditStore };
