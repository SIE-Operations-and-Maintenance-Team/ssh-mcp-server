/**
 * npx 默认模式的 stdio→HTTP 转发代理：
 * - stdin 每行一条 JSON-RPC 消息，POST 到 admin 常驻服务的无状态 /mcp 端点；
 * - 响应兼容 application/json 与 text/event-stream（SDK StreamableHTTP 默认 SSE），
 *   提取 JSON 后回写 stdout；通知类消息（202）无回写；
 * - admin 服务未运行时自动分离拉起，日志落 config 同目录 daemon.log；
 * - 本进程所有日志走 stderr，stdout 仅承载 MCP 协议消息。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { ConfigStore, getGlobalConfigPath } from "../services/config-store.js";
import { DEFAULT_ADMIN_PORT } from "../models/admin-types.js";
import { Logger } from "../utils/logger.js";

/** 探测端口上是否为本项目的 admin 常驻服务（校验 system/info 返回结构） */
export async function probeAdminServer(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/system/info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: unknown; port?: unknown };
    return typeof body?.version === "string" || typeof body?.port === "number";
  } catch {
    return false;
  }
}

/** 从 StreamableHTTP 响应体提取待回写 stdout 的 JSON 串（兼容 application/json 与 text/event-stream） */
export async function extractResponseJsonLines(res: Response): Promise<string[]> {
  const contentType = String(res.headers.get("content-type") || "");
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const payloads: string[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") payloads.push(payload);
      }
    }
    return payloads;
  }
  // application/json 或其他：仅当 body 可解析为 JSON 时透传
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    JSON.parse(trimmed);
    return [trimmed];
  } catch {
    return [];
  }
}

export class StdioProxy {
  constructor(private readonly targetUrl: string) {}

  /** 持续读取 stdin 并转发，stdin 关闭（MCP 客户端退出）后返回 */
  async start(): Promise<void> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      void this.forwardLine(line);
    });
    await new Promise<void>((resolve) => rl.on("close", resolve));
  }

  private async forwardLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let requestId: unknown;
    let hasId = false;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "id" in parsed) {
        hasId = true;
        requestId = (parsed as { id: unknown }).id;
      }
    } catch {
      Logger.log("proxy: 收到无法解析的 stdio 行，已忽略", "error");
      return;
    }
    try {
      const res = await fetch(this.targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: trimmed,
      });
      if (res.status === 202) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const json of await extractResponseJsonLines(res)) {
        process.stdout.write(json + "\n");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.log(`proxy: 转发失败: ${message}`, "error");
      if (hasId) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32000, message: `ssh-mcp-server 常驻服务不可达: ${message}` },
          }) + "\n",
        );
      }
    }
  }
}

/** 解析 admin 端口：CLI 显式指定 > 配置文件 port > 默认 61823 */
async function resolveAdminPort(cliPort?: number): Promise<number> {
  if (cliPort) return cliPort;
  const configPath = process.env.SSH_MCP_CONFIG ? path.resolve(process.env.SSH_MCP_CONFIG) : undefined;
  try {
    const store = new ConfigStore({ configPath });
    const cfg = await store.load();
    if (typeof cfg?.port === "number" && cfg.port > 0) return cfg.port;
  } catch {
    // 配置读取失败时回退默认端口
  }
  return DEFAULT_ADMIN_PORT;
}

/** 确保 admin 常驻服务在目标端口可用，未运行则以分离进程拉起并等待就绪 */
export async function ensureAdminServer(port: number): Promise<void> {
  if (await probeAdminServer(port)) return;

  const script = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!script || !fs.existsSync(script)) {
    throw new Error(`无法定位入口脚本（argv[1]=${process.argv[1] ?? "空"}），请改用 --stdio 或手动运行 --admin`);
  }
  const logDir = path.dirname(getGlobalConfigPath());
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "daemon.log");
  const child = spawn(process.execPath, [script, "--admin", "--admin-port", String(port)], {
    detached: true,
    stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
    cwd: path.dirname(script),
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await probeAdminServer(port, 500)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`admin 常驻服务在端口 ${port} 未能就绪，请查看日志: ${logFile}`);
}

/**
 * 代理模式主流程：解析端口 → 确保 admin 服务运行 → stdio 转发。
 * stdin 关闭后返回（admin 服务保持常驻，供下一次 MCP 会话复用）。
 */
export async function runProxyMode(opts: { adminPort?: number } = {}): Promise<void> {
  const port = await resolveAdminPort(opts.adminPort);
  await ensureAdminServer(port);
  Logger.log(`ssh-mcp-server 管理台: http://127.0.0.1:${port}/admin/`, "info");
  const proxy = new StdioProxy(`http://127.0.0.1:${port}/mcp`);
  await proxy.start();
}
