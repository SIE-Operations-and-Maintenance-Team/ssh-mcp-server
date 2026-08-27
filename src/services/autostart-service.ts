import { execFile } from "node:child_process";
import path from "node:path";

// 登录自启动：写当前用户 HKCU Run 键（无需管理员权限），移植自 MCP-DB-Tools 的 AutostartService
// 注意 reg.exe 必须带根键前缀 HKCU\（.NET 的相对子键路径写法在此不适用）
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "SshMcpServer";

function reg(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export function isAutostartSupported(): boolean {
  return process.platform === "win32";
}

/** 注册表里写入的启动命令：node <当前脚本> --admin（端口随后从 config.json 读取） */
export function buildAutostartCommand(): string {
  const exe = process.execPath;
  const script = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return `"${exe}"${script ? ` "${script}"` : ""} --admin`;
}

export async function getAutostartEnabled(): Promise<boolean> {
  if (!isAutostartSupported()) return false;
  const { code, stdout } = await reg(["query", RUN_KEY, "/v", VALUE_NAME]);
  return code === 0 && stdout.includes(VALUE_NAME);
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isAutostartSupported()) {
    throw new Error("仅支持 Windows（写入 HKCU Run 注册表键）");
  }
  if (enabled) {
    const { code, stderr } = await reg([
      "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", buildAutostartCommand(), "/f",
    ]);
    if (code !== 0) throw new Error(`写入注册表失败: ${stderr}`);
  } else {
    // 不存在时 reg delete 报错，属幂等删除，忽略
    await reg(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
  }
  return getAutostartEnabled();
}
