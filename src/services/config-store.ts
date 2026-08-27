import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chokidar from "chokidar";
import { DEFAULT_ADMIN_PORT } from "../models/admin-types.js";
import { GlobalConfigSchema } from "../models/admin-types.js";

export interface GlobalConfig {
  port: number;
  projects: Record<string, any>;
  projectOrder?: string[];
  audit?: { enabled?: boolean; retentionDays?: number; logResults?: boolean };
  backups?: { retentionDays?: number; maxCount?: number; autoEnabled?: boolean; intervalHours?: number };
  security?: { commandWhitelist?: string[]; commandBlacklist?: string[]; allowedLocalPaths?: string[]; allowedRemotePaths?: string[] };
  preConnect?: boolean;
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

/**
 * Rust 桌面版（serde Option）会把未设置的可选字段序列化为显式 null，
 * 而 Zod 的 .optional() 不接受 null。本项目语义中两者均表示"未设置"，
 * 读取时统一归一为 undefined，保证两版配置文件互通（Rust 写 → Node 读）。
 */
function nullToJsonReviver(_key: string, value: any): any {
  return value === null ? undefined : value;
}

export function getFlatHosts(
  cfg: GlobalConfig,
): Map<string, { project: string; environment: string; host: string; config: any }> {
  const m = new Map<string, { project: string; environment: string; host: string; config: any }>();
  for (const [pName, proj] of Object.entries(cfg.projects || {})) {
    for (const [eName, env] of Object.entries((proj as any).environments || {})) {
      for (const [hName, hCfg] of Object.entries((env as any).hosts || {})) {
        m.set(`${pName}/${eName}/${hName}`, { project: pName, environment: eName, host: hName, config: hCfg });
      }
    }
  }
  return m;
}

export function getFlatHostByName(name: string, cfg: GlobalConfig): any {
  const flat = getFlatHosts(cfg);
  if (flat.has(name)) return { flatName: name, config: flat.get(name)!.config };
  const candidates: string[] = [];
  for (const [k, v] of flat) if (v.host === name) candidates.push(k);
  if (candidates.length === 1) return { flatName: candidates[0], config: flat.get(candidates[0])!.config };
  if (candidates.length > 1) return { ambiguous: true, candidates };
  return null;
}

export class ConfigStore {
  private watchers: Array<() => void> = [];
  constructor(private opts: { configPath?: string } = {}) {}
  get path(): string {
    return this.opts.configPath || getGlobalConfigPath();
  }
  async getFlatHosts(): Promise<Map<string, { project: string; environment: string; host: string; config: any }>> {
    const cfg = await this.load();
    return getFlatHosts(cfg);
  }
  async getFlatHostByName(name: string): Promise<any> {
    const cfg = await this.load();
    return getFlatHostByName(name, cfg);
  }
  async load(): Promise<GlobalConfig> {
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw, nullToJsonReviver);
      return GlobalConfigSchema.parse(parsed);
    } catch (e: any) {
      if (e.code === "ENOENT") return { port: DEFAULT_ADMIN_PORT, projects: {} };
      throw e;
    }
  }
  async save(patch: Partial<GlobalConfig>): Promise<void> {
    const current = await this.load();
    // 深合并 audit/backups/security，防止浅合并丢字段（R1-4）
    const next: any = { ...current, ...patch };
    if (patch.audit && current.audit) next.audit = { ...current.audit, ...patch.audit };
    if (patch.backups && current.backups) next.backups = { ...current.backups, ...patch.backups };
    if (patch.security && current.security) next.security = { ...current.security, ...patch.security };
    GlobalConfigSchema.parse(next);
    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.copyFile(this.path, this.path + ".bak");
    } catch {}
    const tmp = this.path + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
    JSON.parse(await fs.readFile(tmp, "utf-8"));
    await fs.rename(tmp, this.path);
  }
  onChange(cb: (cfg: GlobalConfig) => void): () => void {
    const watcher = chokidar.watch(this.path, { ignoreInitial: true });
    let t: NodeJS.Timeout | null = null;
    watcher.on("all", () => {
      if (t) clearTimeout(t);
      t = setTimeout(async () => {
        cb(await this.load());
      }, 200);
    });
    return () => watcher.close();
  }
}
