#!/usr/bin/env node

import { SshMcpServer } from "./core/mcp-server.js";
import { SERVER_CONFIG } from "./config/server.js";
import { Logger } from "./utils/logger.js";
import { CommandLineParser } from "./cli/command-line-parser.js";
import { ConfigStore, getGlobalConfigPath } from "./services/config-store.js";
import { DEFAULT_ADMIN_PORT } from "./models/admin-types.js";
import { startAdminServer } from "./server/index.js";

const HELP_TEXT = `Usage: ssh-mcp-server [options] [host port username password]

Options:
  --config-file <path>             Load SSH server configs from a JSON file
  --ssh-config-file <path>         Read host aliases from SSH config (default: ~/.ssh/config)
  --ssh <config>                   Add an SSH config as JSON or legacy key=value pairs (repeatable)
  -h, --host <host>                SSH host or SSH config alias for single-host mode
  -p, --port <port>                SSH port for single-host mode
  -u, --username <name>            SSH username for single-host mode
  -w, --password <password>        SSH password for single-host mode
  -k, --privateKey <path>          SSH private key path for single-host mode
  -P, --passphrase <passphrase>    SSH private key passphrase
  -a, --agent <path>               SSH agent socket path or pageant on Windows
  -W, --whitelist <patterns>       Command whitelist regexes, comma-separated
  -B, --blacklist <patterns>       Command blacklist regexes, comma-separated
  --proxy <url>                    Proxy URL (SOCKS5, HTTP, or HTTPS)
  -s, --socksProxy <url>           Legacy SOCKS5 proxy URL
  --allowed-local-paths <paths>    Extra allowed local paths, comma-separated
  --allowed-remote-paths <paths>   Allowed remote POSIX absolute paths, comma-separated
  --transport-mode <mode>          SSH transport mode: exec or shell (default: exec)
  --shell-ready-timeout <ms>       Shell readiness probe timeout (default: 10000)
  --command-template <template>    Wrap commands with <command> or <quotedCommand>
  --pty                           Allocate pseudo-tty for exec mode commands (default: true)
  --try-keyboard                  Enable keyboard-interactive authentication
  --pre-connect                   Pre-connect to all SSH servers on startup
  --admin                         Start admin HTTP server (127.0.0.1:${DEFAULT_ADMIN_PORT})
  --admin-port <port>             Admin HTTP port (default ${DEFAULT_ADMIN_PORT}, overrides config file)
  --version, -v                   Print package version
  --help                          Print this help message`;

function hasArg(...names: string[]): boolean {
  return process.argv.slice(2).some((arg) => names.includes(arg));
}

function getArgValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

/**
 * Main program entry
 */
async function main(): Promise<void> {
  if (hasArg("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (hasArg("--version", "-v")) {
    console.log(SERVER_CONFIG.version);
    return;
  }

  // Admin mode: single Fastify host 127.0.0.1, priority CLI > file > default
  if (hasArg("--admin")) {
    const parsed = CommandLineParser.parseArgs();
    // --admin-port is the authoritative admin port (distinct from --port SSH port)
    const cliPort = parsed.adminPort;
    // Config file override chain: --config-file > SSH_MCP_CONFIG env > global path
    const configPath = parsed.configFile ?? process.env.SSH_MCP_CONFIG ?? getGlobalConfigPath();
    // For admin mode, we still need to respect stored port if no CLI override
    let filePort: number | undefined;
    try {
      const store = new ConfigStore({ configPath });
      const cfg = await store.load();
      filePort = cfg.port;
    } catch {}
    const port = cliPort ?? filePort ?? DEFAULT_ADMIN_PORT;
    const srv = await startAdminServer({ port, configPath });
    Logger.log(`Admin server listening on 127.0.0.1:${srv.port}`, "info");
    return;
  }

  const sshMcpServer = new SshMcpServer();
  await sshMcpServer.run();
}

main().catch((error) => Logger.handleError(error, "【SSH MCP Server Error】", true));
