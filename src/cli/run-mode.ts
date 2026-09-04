/**
 * 运行模式路由（npx 分发形态）：
 * - --admin                          → admin 常驻服务（管理台 + HTTP MCP）
 * - --stdio 或任何 SSH 连接/配置参数 → 传统 stdio MCP（MCP 客户端拉起子进程直连）
 * - 无参数（npx 默认）              → proxy：自动拉起/复用 admin 常驻服务，本进程做 stdio→HTTP 转发
 */
export interface RunMode {
  mode: "admin" | "stdio" | "proxy";
  adminPort?: number;
}

/** 出现任一参数即视为传统 stdio 模式（SSH 连接与配置相关的全部开关） */
const STDIO_ARGS = [
  "config-file",
  "ssh",
  "ssh-config-file",
  "host", "h",
  "port", "p",
  "username", "u",
  "password", "w",
  "privateKey", "k",
  "passphrase", "P",
  "agent", "a",
  "whitelist", "W",
  "blacklist", "B",
  "proxy",
  "socksProxy", "s",
  "allowed-local-paths",
  "allowed-remote-paths",
  "transport-mode",
  "shell-ready-timeout",
  "command-template",
  "pty",
  "try-keyboard",
  "pre-connect",
];

/** 解析 --admin-port 的值，非法或缺参返回 undefined */
export function parseAdminPort(argv: string[]): number | undefined {
  const idx = argv.indexOf("--admin-port");
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const port = parseInt(argv[idx + 1], 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export function resolveRunMode(argv: string[]): RunMode {
  if (argv.includes("--admin")) return { mode: "admin", adminPort: parseAdminPort(argv) };
  if (argv.includes("--stdio")) return { mode: "stdio" };
  const hasArg = (name: string) => argv.includes(`--${name}`) || argv.includes(`-${name}`);
  if (STDIO_ARGS.some(hasArg)) return { mode: "stdio" };
  return { mode: "proxy", adminPort: parseAdminPort(argv) };
}
