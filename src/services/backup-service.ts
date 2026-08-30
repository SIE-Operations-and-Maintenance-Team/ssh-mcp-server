import fs from "node:fs/promises";
import path from "node:path";
import type { ConfigStore } from "./config-store.js";

export interface BackupItem { id: string; name: string; path: string; ts: number }

/** 从备份文件名解析创建时间（config-YYYY-MM-DDTHH-mm-ss-sssZ.json，UTC）；解析失败返回 null。
 *  不直接用 mtime：Windows 上 copyFile 保留源文件的 mtime，会让所有备份展示同一时间 */
export function tsFromName(name: string): number | null {
  const m = /^config-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
}

export class BackupService {
  constructor(private store: ConfigStore) {}
  private get dir() { return path.join(path.dirname(this.store.path), "backups"); }

  async prune(retentionDays?: number, maxCount?: number): Promise<{ deleted: string[] }> {
    const items = await this.list();
    const deleted: string[] = [];
    const now = Date.now();
    // 按 retentionDays 清理过期
    if (retentionDays && retentionDays > 0) {
      const cutoff = now - retentionDays * 24 * 3600 * 1000;
      for (const it of items) {
        if (it.ts && it.ts < cutoff) {
          try { await fs.unlink(it.path); deleted.push(it.id); } catch {}
        }
      }
    }
    // 重新列出剩余，按 maxCount 截断
    const remaining = (await this.list()).filter((i) => !deleted.includes(i.id));
    if (maxCount && maxCount > 0 && remaining.length > maxCount) {
      const toRemove = remaining.slice(maxCount);
      for (const it of toRemove) {
        try { await fs.unlink(it.path); deleted.push(it.id); } catch {}
      }
    }
    return { deleted };
  }

  async snapshot(): Promise<BackupItem> {
    await fs.mkdir(this.dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `config-${ts}.json`;
    const dst = path.join(this.dir, name);
    try { await fs.copyFile(this.store.path, dst); } catch (e: any) {
      // 若源不存在，创建一个空快照
      if (e.code === "ENOENT") {
        const cfg = await this.store.load();
        await fs.writeFile(dst, JSON.stringify(cfg, null, 2), "utf-8");
      } else throw e;
    }
    // Windows copyFile 保留源 mtime，重置为当前时间，让文件系统时间与备份创建时间一致
    const now = new Date();
    try { await fs.utimes(dst, now, now); } catch {}
    // 自动按保留策略清理
    try {
      const cfg: any = await this.store.load();
      await this.prune(cfg?.backups?.retentionDays, cfg?.backups?.maxCount);
    } catch {}
    return { id: name, name, path: dst, ts: Date.now() };
  }

  async list(): Promise<BackupItem[]> {
    try {
      const files = await fs.readdir(this.dir);
      const items: BackupItem[] = [];
      for (const f of files.filter(f => f.endsWith(".json")).sort().reverse()) {
        const p = path.join(this.dir, f);
        // 优先用文件名内嵌时间戳；非标准命名回退到 mtime
        const fromName = tsFromName(f);
        if (fromName !== null) {
          items.push({ id: f, name: f, path: p, ts: fromName });
          continue;
        }
        try {
          const stat = await fs.stat(p);
          items.push({ id: f, name: f, path: p, ts: stat.mtimeMs });
        } catch { items.push({ id: f, name: f, path: p, ts: 0 }); }
      }
      return items;
    } catch { return []; }
  }

  async restore(id: string) {
    // 先快照当前
    await this.snapshot();
    const src = path.join(this.dir, id);
    await fs.copyFile(src, this.store.path);
  }
}
