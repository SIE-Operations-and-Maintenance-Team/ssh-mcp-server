import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

export interface AuditEntry {
  id?: number;
  ts: number;
  connection: string;
  tool: string;
  status: string;
  sql?: string;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  q?: string;
  connection?: string;
  tool?: string;
  status?: string;
}

export class AuditStore {
  private db: any = null;
  private mem: AuditEntry[] = [];
  private nextId = 1;
  private useDb = false;
  // 保留天数（由配置注入）：写入时顺带清理过期记录，让设置页的"审计保留天数"生效
  public retentionDays?: number;

  constructor(dbPath?: string) {
    const p = dbPath || path.join(os.homedir(), ".config", "ssh-mcp-server", "audit.db");
    if (p === ":memory:") {
      this.useDb = false;
      return;
    }
    try {
      // R2: better-sqlite3 为原生模块，esbuild 需 external，Tauri release 需 via resources 附带 node_modules
      const Database = (awaitImportBetterSqlite3() as any);
      if (Database) {
        const dir = path.dirname(p);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        this.db = new Database(p);
        this.db.exec(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, connection TEXT, tool TEXT, status TEXT, sql TEXT)`);
        this.useDb = true;
      }
    } catch {
      this.useDb = false;
    }
  }

  log(e: Omit<AuditEntry, "ts" | "id"> & { ts?: number }) {
    const entry: AuditEntry = { ts: e.ts ?? Date.now(), connection: e.connection, tool: e.tool, status: e.status, sql: e.sql || "" };
    if (this.retentionDays && this.retentionDays > 0) {
      const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000;
      if (this.useDb && this.db) {
        try { this.db.prepare(`DELETE FROM audit WHERE ts < ?`).run(cutoff); } catch {}
      } else {
        this.mem = this.mem.filter((m) => (m.ts ?? 0) >= cutoff);
      }
    }
    if (this.useDb && this.db) {
      this.db.prepare(`INSERT INTO audit (ts,connection,tool,status,sql) VALUES (?,?,?,?,?)`).run(entry.ts, entry.connection, entry.tool, entry.status, entry.sql);
    } else {
      entry.id = this.nextId++;
      this.mem.push(entry);
    }
  }

  query(opts: AuditQuery) {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.max(1, Math.min(100, opts.pageSize || 20));
    if (this.useDb && this.db) {
      const where: string[] = [];
      const params: any[] = [];
      if (opts.q) { where.push(`(connection LIKE ? OR tool LIKE ? OR sql LIKE ?)`); const like = `%${opts.q}%`; params.push(like, like, like); }
      if (opts.connection) { where.push(`connection = ?`); params.push(opts.connection); }
      if (opts.tool) { where.push(`tool = ?`); params.push(opts.tool); }
      if (opts.status) { where.push(`status = ?`); params.push(opts.status); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = (this.db.prepare(`SELECT COUNT(*) as c FROM audit ${clause}`).get(...params) as any).c as number;
      const rows = this.db.prepare(`SELECT * FROM audit ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return { total, rows, page, pageSize };
    } else {
      let rows = [...this.mem];
      if (opts.q) {
        const q = opts.q.toLowerCase();
        rows = rows.filter(r => `${r.connection} ${r.tool} ${r.sql}`.toLowerCase().includes(q));
      }
      if (opts.connection) rows = rows.filter(r => r.connection === opts.connection);
      if (opts.tool) rows = rows.filter(r => r.tool === opts.tool);
      if (opts.status) rows = rows.filter(r => r.status === opts.status);
      rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
      const total = rows.length;
      const sliced = rows.slice((page - 1) * pageSize, page * pageSize);
      return { total, rows: sliced, page, pageSize };
    }
  }

  close() {
    if (this.db) { try { this.db.close(); } catch {} }
  }
}

function awaitImportBetterSqlite3(): any {
  try {
    const req = createRequire(import.meta.url);
    return req("better-sqlite3");
  } catch {}
  return null;
}

// 服务层全局单例：MCP 执行链路与 HTTP 审计路由共用同一份记录，UI 审计页才能看到执行流水
export const globalAuditStore = new AuditStore();
