import { spawn } from "node:child_process";
import path from "node:path";
import { SERVER_CONFIG } from "../config/server.js";

// 应用更新：对照 npm registry 的 latest 版本（本项目经 npm 分发），
// 语义移植自 MCP-DB-Tools 的 UpdateChecker（Velopack/GitHub Releases）：
// status 只读缓存、check 走网络、installed 区分 npm 安装与本地开发模式。
const PKG = "@sieop/ssh-mcp-server";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG)}`;

export interface UpdateStatus {
  configured: boolean;
  installed: boolean;
  checked: boolean;
  hasUpdate: boolean;
  targetVersion: string;
  downloaded: boolean;
  error?: string;
}

const state: UpdateStatus = {
  configured: true,
  installed: false,
  checked: false,
  hasUpdate: false,
  targetVersion: "",
  downloaded: false,
};

let cachedVersion = "";
export function getCurrentVersion(): string {
  // SERVER_CONFIG.version 构建期直接读 package.json（缺失即报错），这里仅做字符串化缓存
  if (cachedVersion) return cachedVersion;
  cachedVersion = String(SERVER_CONFIG.version || "");
  return cachedVersion;
}

/** 运行脚本位于 node_modules 内（npm 全局/npx 安装）才算正式安装；本地 build 目录属开发模式 */
export function isNpmInstalled(): boolean {
  const script = process.argv[1] || "";
  return script.includes(`node_modules${path.sep}@sieop`);
}

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0（忽略预发布标签，缺位补 0） */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const parts = v.trim().replace(/^v/i, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
    return [...parts, 0, 0, 0].slice(0, 3);
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

export function getUpdateStatus(): UpdateStatus {
  return { ...state, installed: isNpmInstalled() };
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const meta: any = await res.json();
    const latest: string | undefined = meta?.["dist-tags"]?.latest;
    if (!latest) throw new Error("registry 响应缺少 dist-tags.latest");
    state.checked = true;
    state.targetVersion = latest;
    state.hasUpdate = compareSemver(latest, getCurrentVersion()) > 0;
    state.downloaded = false;
    state.error = undefined;
  } catch (e: any) {
    state.checked = true;
    state.error = String(e?.message || e);
  }
  return getUpdateStatus();
}

/** 安装最新版到全局（进程随后由 restart-helper 以原路径重启，同路径即新版本） */
export function installLatest(): Promise<void> {
  state.error = undefined;
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "-g", `${PKG}@latest`], {
      shell: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else {
        state.error = `npm install 退出码 ${code}`;
        reject(new Error(state.error));
      }
    });
  });
}
