import { parseArgs } from "node:util";
import { DEFAULT_ADMIN_PORT } from "../models/admin-types.js";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import { lookupSshConfig } from "../utils/ssh-config-parser.js";
import { Logger } from "../utils/logger.js";

/**
 * Command line argument parser class
 */
export class CommandLineParser {
  private static readonly DEFAULT_TRANSPORT_MODE: SSHConfig["transportMode"] = "exec";
  private static readonly DEFAULT_SHELL_READY_TIMEOUT_MS = 10000;

  private static parseBoolean(value: unknown): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    return Boolean(value);
  }

  private static parseTransportMode(
    value: unknown,
  ): SSHConfig["transportMode"] | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    if (value === "exec" || value === "shell") {
      return value;
    }

    throw new Error(
      `transportMode must be either 'exec' or 'shell', got: ${String(value)}`,
    );
  }

  private static parseTimeout(
    value: unknown,
    fieldName: string,
  ): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const parsed =
      typeof value === "number" ? value : parseInt(String(value), 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${fieldName} must be a positive number, got: ${String(value)}`);
    }

    return parsed;
  }

  private static parseMaxOutputBytes(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const parsed = typeof value === "number" ? value : Number(String(value));

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        `maxOutputBytes must be a non-negative integer, got: ${String(value)}`,
      );
    }

    return parsed;
  }

  /**
   * Parse command line arguments
   */
  public static parseArgs(): ParsedArgs {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "config-file": { type: "string" },
        "ssh-config-file": { type: "string" },
        ssh: { type: "string", multiple: true },
        // Compatible with single connection legacy parameters
        host: { type: "string", short: "h" },
        port: { type: "string", short: "p" },
        username: { type: "string", short: "u" },
        password: { type: "string", short: "w" },
        privateKey: { type: "string", short: "k" },
        passphrase: { type: "string", short: "P" },
        agent: { type: "string", short: "a" },
        whitelist: { type: "string", short: "W" },
        blacklist: { type: "string", short: "B" },
        proxy: { type: "string" },
        socksProxy: { type: "string", short: "s" },
        "allowed-local-paths": { type: "string" },
        "allowed-remote-paths": { type: "string" },
        "transport-mode": { type: "string" },
        "shell-ready-timeout": { type: "string" },
        "command-template": { type: "string" },
        pty: { type: "boolean" },
        "try-keyboard": { type: "boolean" },
        "pre-connect": { type: "boolean" },
        admin: { type: "boolean" },
        "admin-port": { type: "string" },
      },
      allowPositionals: true,
    });

    const configMap: SshConnectionConfigMap = {};

    // Priority 1: Load from config file if specified
    if (values["config-file"]) {
      const configFilePath = path.resolve(values["config-file"]);
      if (!fs.existsSync(configFilePath)) {
        throw new Error(`Config file not found: ${configFilePath}`);
      }
      try {
        const configContent = fs.readFileSync(configFilePath, "utf-8");
        const fileConfig = JSON.parse(configContent);
        
        // Support both array format and object format
        if (Array.isArray(fileConfig)) {
          // Array format: [{name: "dev", host: "...", ...}, ...]
          for (const config of fileConfig) {
            if (!config.name || !config.host || !config.port || !config.username) {
              throw new Error("Each config in array must include name, host, port, username");
            }
            configMap[config.name] = this.normalizeConfig(config);
          }
        } else if (typeof fileConfig === "object" && fileConfig !== null) {
          // Object format: {"dev": {host: "...", ...}, "prod": {...}}
          for (const [name, config] of Object.entries(fileConfig)) {
            const normalizedConfig = this.normalizeConfig(config as any);
            normalizedConfig.name = name;
            configMap[name] = normalizedConfig;
          }
        } else {
          throw new Error("Config file must contain an array or object of SSH configurations");
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`Invalid JSON in config file: ${(err as Error).message}`);
        }
        throw err;
      }
    }

    // Priority 2: Parse --ssh parameters (only if no config file was loaded)
    if (Object.keys(configMap).length === 0) {
      const sshParams: string[] = Array.isArray(values.ssh)
        ? values.ssh
        : values.ssh
        ? [values.ssh]
        : [];

      for (const sshStr of sshParams) {
        let conf: SSHConfig;
        
        // Try to parse as JSON first
        if (sshStr.trim().startsWith("{")) {
          try {
            const jsonConfig = JSON.parse(sshStr);
            conf = this.normalizeConfig(jsonConfig);
            if (!conf.name) {
              throw new Error("JSON config must include 'name' field");
            }
          } catch (err) {
            throw new Error(`Invalid JSON format in --ssh parameter: ${(err as Error).message}`);
          }
        } else {
          // Fallback to legacy comma-separated format for backward compatibility
          conf = this.parseLegacySshFormat(sshStr);
        }
        
        if (!conf.name || !conf.host || !conf.port || !conf.username) {
          throw new Error("Each --ssh must include name, host, port, username");
        }
        configMap[conf.name] = conf;
      }
    }

    // Priority 3: skip legacy single-host validation when --admin (GUI 模式允许零连接)
    if (values.admin === true && Object.keys(configMap).length === 0) {
      return {
        configs: configMap,
        preConnect: values["pre-connect"] === true,
        admin: true,
        adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
        configFile: values["config-file"] ? String(values["config-file"]) : undefined,
      };
    }

    // Priority 3: Compatible with single connection legacy parameters
    if (Object.keys(configMap).length === 0) {
      const host = values.host || positionals[0];

      // 尝试从 SSH config 读取配置
      let sshConfigEntry = null;
      if (host) {
        try {
          sshConfigEntry = lookupSshConfig(host, values["ssh-config-file"]);
        } catch (err) {
          // 显式指定配置文件但读取失败时抛错
          throw err;
        }
      }

      const portStr = values.port || positionals[1] || sshConfigEntry?.port?.toString() || "22";
      const username = values.username || positionals[2] || sshConfigEntry?.user;
      const password = values.password || positionals[3];
      const privateKey = values.privateKey || sshConfigEntry?.identityFile;
      const passphrase = values.passphrase || process.env.SSH_MCP_PASSPHRASE;
      const resolvedAgent = values.agent !== undefined
        ? values.agent
        : !password && !privateKey
        ? process.env.SSH_AUTH_SOCK
        : undefined;
      const whitelist = values.whitelist;
      const blacklist = values.blacklist;
      const allowedLocalPaths = values["allowed-local-paths"];
      const allowedRemotePaths = values["allowed-remote-paths"];
      const commandTemplate = values["command-template"];
      const pty = values.pty;
      const tryKeyboard = values["try-keyboard"];

      // 实际连接地址：优先使用 SSH config 的 HostName
      const actualHost = sshConfigEntry?.hostName || host;

      if (!actualHost || !portStr || !username || (!password && !privateKey && !resolvedAgent)) {
        throw new Error(
          "Missing required parameters, need to provide host, port, username and password, private key or agent"
        );
      }

      const port = parseInt(portStr, 10);
      if (isNaN(port)) {
        throw new Error("Port must be a valid number");
      }

      configMap["default"] = this.normalizeConfig({
        name: "default",
        host: actualHost,
        port,
        username,
        password,
        privateKey,
        passphrase,
        agent: resolvedAgent,
        proxy: values.proxy,
        socksProxy: values.socksProxy,
        pty: pty !== undefined ? pty : undefined,
        tryKeyboard: tryKeyboard !== undefined ? tryKeyboard : undefined,
        transportMode: values["transport-mode"],
        shellReadyTimeoutMs: values["shell-ready-timeout"],
        commandTemplate,
        commandWhitelist: whitelist
          ? whitelist
              .split(",")
              .map((pattern) => pattern.trim())
              .filter(Boolean)
          : undefined,
        commandBlacklist: blacklist
          ? blacklist
              .split(",")
              .map((pattern) => pattern.trim())
              .filter(Boolean)
          : undefined,
        allowedLocalPaths: allowedLocalPaths
          ? allowedLocalPaths
              .split(",")
              .map((allowedPath) => allowedPath.trim())
              .filter(Boolean)
          : undefined,
        allowedRemotePaths: allowedRemotePaths
          ? allowedRemotePaths
              .split(",")
              .map((allowedPath) => allowedPath.trim())
              .filter(Boolean)
          : undefined,
      });
    }

    return {
      configs: configMap,
      preConnect: values["pre-connect"] === true,
      admin: values.admin === true,
      adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
      configFile: values["config-file"] ? String(values["config-file"]) : undefined,
    };
  }

  /**
   * Parse legacy comma-separated format: name=dev,host=1.2.3.4,port=22,user=alice,password=xxx
   * @private
   */
  private static parseLegacySshFormat(sshStr: string): SSHConfig {
    const conf: any = {};
    const parts = sshStr.split(",");
    
    for (const part of parts) {
      // Only split on the first '=' to handle values containing '='
      const equalIndex = part.indexOf("=");
      if (equalIndex > 0) {
        const k = part.substring(0, equalIndex).trim();
        const v = part.substring(equalIndex + 1).trim();
        if (k && v) {
          conf[k] = v;
        }
      }
    }
    
    const port = parseInt(conf.port, 10);
    if (isNaN(port)) {
      throw new Error(
        `Port for connection ${conf.name || "unknown"} must be a valid number`
      );
    }
    
    return this.normalizeConfig(conf);
  }

  /**
   * Normalize SSH config object to ensure proper types and structure
   * @private
   */
  private static normalizeConfig(config: any): SSHConfig {
    const port = typeof config.port === "number"
      ? config.port
      : parseInt(config.port, 10);

    if (isNaN(port)) {
      throw new Error(`Port must be a valid number, got: ${config.port}`);
    }

    return {
      name: config.name,
      host: config.host,
      port,
      username: config.username || config.user,
      password: config.password,
      privateKey: config.privateKey
        ? this.normalizeLocalPath(String(config.privateKey))
        : undefined,
      passphrase: config.passphrase || process.env.SSH_MCP_PASSPHRASE,
      agent: config.agent,
      algorithms: config.algorithms,
      proxy: config.proxy,
      socksProxy: config.socksProxy,
      pty: this.parseBoolean(config.pty),
      tryKeyboard: this.parseBoolean(config.tryKeyboard),
      transportMode:
        this.parseTransportMode(config.transportMode) ||
        this.DEFAULT_TRANSPORT_MODE,
      shellReadyTimeoutMs:
        this.parseTimeout(
          config.shellReadyTimeoutMs,
          "shellReadyTimeoutMs",
        ) || this.DEFAULT_SHELL_READY_TIMEOUT_MS,
      shellCommandTimeoutMs: this.parseTimeout(
        config.shellCommandTimeoutMs,
        "shellCommandTimeoutMs",
      ),
      commandTimeoutMs: this.parseTimeout(
        config.commandTimeoutMs,
        "commandTimeoutMs",
      ),
      connectionTimeoutMs: this.parseTimeout(
        config.connectionTimeoutMs,
        "connectionTimeoutMs",
      ),
      sftpTimeoutMs: this.parseTimeout(config.sftpTimeoutMs, "sftpTimeoutMs"),
      maxOutputBytes: this.parseMaxOutputBytes(config.maxOutputBytes),
      keepaliveIntervalMs: this.parseTimeout(
        config.keepaliveIntervalMs,
        "keepaliveIntervalMs",
      ),
      keepaliveCountMax: this.parseTimeout(
        config.keepaliveCountMax,
        "keepaliveCountMax",
      ),
      commandWhitelist: Array.isArray(config.commandWhitelist)
        ? config.commandWhitelist
        : config.whitelist
        ? typeof config.whitelist === "string"
          ? config.whitelist.split("|").map((s: string) => s.trim()).filter(Boolean)
          : config.whitelist
        : undefined,
      commandBlacklist: Array.isArray(config.commandBlacklist)
        ? config.commandBlacklist
        : config.blacklist
        ? typeof config.blacklist === "string"
          ? config.blacklist.split("|").map((s: string) => s.trim()).filter(Boolean)
          : config.blacklist
        : undefined,
      allowedLocalPaths: Array.isArray(config.allowedLocalPaths)
        ? config.allowedLocalPaths
            .map((allowedPath: unknown) =>
              this.normalizeLocalPath(String(allowedPath)),
            )
            .filter(Boolean)
        : typeof config.allowedLocalPaths === "string"
          ? config.allowedLocalPaths
              .split("|")
              .map((allowedPath: string) =>
                this.normalizeLocalPath(allowedPath.trim()),
              )
              .filter(Boolean)
          : undefined,
      allowedRemotePaths: Array.isArray(config.allowedRemotePaths)
        ? config.allowedRemotePaths
            .map((allowedPath: unknown) =>
              this.normalizeRemotePath(String(allowedPath)),
            )
        : typeof config.allowedRemotePaths === "string"
          ? config.allowedRemotePaths
              .split("|")
              .map((allowedPath: string) =>
                this.normalizeRemotePath(allowedPath.trim()),
              )
              .filter(Boolean)
          : undefined,
      commandTemplate: this.parseCommandTemplate(config.commandTemplate),
    };
  }

  private static parseCommandTemplate(
    value: unknown,
  ): string | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const template = String(value);
    if (!template.includes("<command>") && !template.includes("<quotedCommand>")) {
      throw new Error(
        `commandTemplate must contain '<command>' or '<quotedCommand>' placeholder, got: ${template}`,
      );
    }

    return template;
  }

  private static normalizeLocalPath(localPath: string): string {
    return path.resolve(this.expandHomePath(localPath));
  }

  private static expandHomePath(localPath: string): string {
    if (localPath === "~") {
      return os.homedir();
    }
    if (localPath.startsWith("~/")) {
      return path.join(os.homedir(), localPath.slice(2));
    }
    return localPath;
  }

  private static normalizeRemotePath(remotePath: string): string {
    if (!remotePath) {
      return "";
    }
    if (!path.posix.isAbsolute(remotePath)) {
      throw new Error(
        `allowedRemotePaths entries must be absolute POSIX paths, got: ${remotePath}`,
      );
    }
    const normalized = path.posix.normalize(remotePath);
    if (normalized.length > 1 && normalized.endsWith("/")) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }

  public static migrateLegacy(raw: any): any {
    if (!raw || typeof raw !== "object" || !raw.connections) {
      return raw;
    }
    Logger.log(
      "检测到旧格式 connections，已迁移至 projects.default.environments.default",
      "info",
    );
    const hosts: Record<string, any> = Array.isArray(raw.connections)
      ? Object.fromEntries(
          (raw.connections as any[]).map((c: any) => [c.name, c]),
        )
      : (raw.connections as Record<string, any>);
    raw.projects = raw.projects || {};
    if (!raw.projects.default) {
      raw.projects.default = {
        displayName: "默认项目",
        environments: {},
      };
    }
    if (!raw.projects.default.displayName) {
      raw.projects.default.displayName = "默认项目";
    }
    raw.projects.default.environments = raw.projects.default.environments || {};
    if (!raw.projects.default.environments.default) {
      raw.projects.default.environments.default = {
        displayName: "默认环境",
        hosts: {},
      };
    }
    if (!raw.projects.default.environments.default.displayName) {
      raw.projects.default.environments.default.displayName = "默认环境";
    }
    raw.projects.default.environments.default.hosts =
      raw.projects.default.environments.default.hosts || {};
    for (const [k, v] of Object.entries(hosts)) {
      const key = (v as any)?.name ? String((v as any).name) : k;
      raw.projects.default.environments.default.hosts[key] = v;
    }
    delete raw.connections;
    return raw;
  }

  private static buildDefaultHierarchy(hostCfg: SSHConfig): any {
    return {
      default: {
        displayName: "默认项目",
        environments: {
          default: {
            displayName: "默认环境",
            hosts: {
              default: hostCfg,
            },
          },
        },
      },
    };
  }

  public static parse(argv: string[]): any {
    const args = argv ?? process.argv.slice(2);
    const { values, positionals } = parseArgs({
      args,
      options: {
        "config-file": { type: "string" },
        "ssh-config-file": { type: "string" },
        ssh: { type: "string", multiple: true },
        host: { type: "string", short: "h" },
        port: { type: "string", short: "p" },
        username: { type: "string", short: "u" },
        password: { type: "string", short: "w" },
        privateKey: { type: "string", short: "k" },
        passphrase: { type: "string", short: "P" },
        agent: { type: "string", short: "a" },
        whitelist: { type: "string", short: "W" },
        blacklist: { type: "string", short: "B" },
        proxy: { type: "string" },
        socksProxy: { type: "string", short: "s" },
        "allowed-local-paths": { type: "string" },
        "allowed-remote-paths": { type: "string" },
        "transport-mode": { type: "string" },
        "shell-ready-timeout": { type: "string" },
        "command-template": { type: "string" },
        pty: { type: "boolean" },
        "try-keyboard": { type: "boolean" },
        "pre-connect": { type: "boolean" },
        admin: { type: "boolean" },
        "admin-port": { type: "string" },
      },
      allowPositionals: true,
    });

    // Priority 1: config file
    if (values["config-file"]) {
      const configFilePath = path.resolve(values["config-file"] as string);
      if (!fs.existsSync(configFilePath)) {
        throw new Error(`Config file not found: ${configFilePath}`);
      }
      const configContent = fs.readFileSync(configFilePath, "utf-8");
      const raw: any = JSON.parse(configContent);
      // legacy connections migration
      if (raw.connections) {
        this.migrateLegacy(raw);
        return {
          port: raw.port ?? DEFAULT_ADMIN_PORT,
          projects: raw.projects,
          audit: raw.audit,
          backups: raw.backups,
          security: raw.security,
          preConnect: raw.preConnect,
        };
      }
      // new hierarchy file
      if (raw.projects) {
        return {
          port: raw.port ?? DEFAULT_ADMIN_PORT,
          projects: raw.projects,
          audit: raw.audit,
          backups: raw.backups,
          security: raw.security,
          preConnect: raw.preConnect,
        };
      }
      // flat legacy without wrapper: array or object of hosts -> migrate to default/default
      if (Array.isArray(raw)) {
        const hosts: Record<string, any> = {};
        for (const c of raw) {
          if (c.name) hosts[c.name] = this.normalizeConfig(c);
        }
        Logger.log(
          "检测到旧格式 connections，已迁移至 projects.default.environments.default",
          "info",
        );
        return {
          port: DEFAULT_ADMIN_PORT,
          projects: {
            default: {
              displayName: "默认项目",
              environments: {
                default: { displayName: "默认环境", hosts },
              },
            },
          },
        };
      }
      if (typeof raw === "object" && raw !== null) {
        const maybeHosts = Object.values(raw).some(
          (v: any) => v && typeof v === "object" && "host" in v,
        );
        if (maybeHosts) {
          const hosts: Record<string, any> = {};
          for (const [k, v] of Object.entries(raw as Record<string, any>)) {
            const conf: any = v as any;
            const normalized = this.normalizeConfig({ ...conf, name: conf.name || k });
            hosts[normalized.name || k] = normalized;
          }
          Logger.log(
            "检测到旧格式 connections，已迁移至 projects.default.environments.default",
            "info",
          );
          return {
            port: DEFAULT_ADMIN_PORT,
            projects: {
              default: {
                displayName: "默认项目",
                environments: {
                  default: { displayName: "默认环境", hosts },
                },
              },
            },
          };
        }
      }
      return raw;
    }

    // Priority 2: --ssh params -> hierarchy default/default
    const sshParams: string[] = Array.isArray(values.ssh)
      ? (values.ssh as string[])
      : values.ssh
        ? [values.ssh as string]
        : [];
    if (sshParams.length > 0) {
      const hosts: Record<string, any> = {};
      for (const sshStr of sshParams) {
        let conf: SSHConfig;
        if (sshStr.trim().startsWith("{")) {
          const jsonConfig = JSON.parse(sshStr);
          conf = this.normalizeConfig(jsonConfig);
          if (!conf.name) throw new Error("JSON config must include 'name' field");
        } else {
          conf = this.parseLegacySshFormat(sshStr);
        }
        if (!conf.name || !conf.host || !conf.port || !conf.username) {
          throw new Error("Each --ssh must include name, host, port, username");
        }
        hosts[conf.name] = conf;
      }
      Logger.log(
        "检测到旧格式 connections，已迁移至 projects.default.environments.default",
        "info",
      );
      return {
        port: DEFAULT_ADMIN_PORT,
        projects: {
          default: {
            displayName: "默认项目",
            environments: {
              default: { displayName: "默认环境", hosts },
            },
          },
        },
        preConnect: values["pre-connect"] === true,
        admin: values.admin === true,
        adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
        configFile: values["config-file"] ? String(values["config-file"]) : undefined,
      };
    }

    // Priority: --admin without hosts
    if (values.admin === true) {
      const host = (values.host as string | undefined) || (positionals[0] as string | undefined);
      if (!host) {
        return {
          port: DEFAULT_ADMIN_PORT,
          projects: {},
          preConnect: values["pre-connect"] === true,
          admin: true,
          adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
          configFile: values["config-file"] ? String(values["config-file"]) : undefined,
        };
      }
    }

    // Priority 3: single host -> default/default/default
    const host = (values.host as string | undefined) || (positionals[0] as string | undefined);
    if (host) {
      let sshConfigEntry: any = null;
      try {
        sshConfigEntry = lookupSshConfig(host, values["ssh-config-file"] as string | undefined);
      } catch (err) {
        throw err;
      }
      const portStr =
        (values.port as string | undefined) ||
        (positionals[1] as string | undefined) ||
        sshConfigEntry?.port?.toString() ||
        "22";
      const username =
        (values.username as string | undefined) ||
        (positionals[2] as string | undefined) ||
        sshConfigEntry?.user;
      const password = (values.password as string | undefined) || (positionals[3] as string | undefined);
      const privateKey = (values.privateKey as string | undefined) || sshConfigEntry?.identityFile;
      const passphrase = (values.passphrase as string | undefined) || process.env.SSH_MCP_PASSPHRASE;
      const resolvedAgent =
        values.agent !== undefined
          ? (values.agent as string)
          : !password && !privateKey
            ? process.env.SSH_AUTH_SOCK
            : undefined;
      const whitelist = values.whitelist as string | undefined;
      const blacklist = values.blacklist as string | undefined;
      const allowedLocalPaths = values["allowed-local-paths"] as string | undefined;
      const allowedRemotePaths = values["allowed-remote-paths"] as string | undefined;
      const commandTemplate = values["command-template"] as string | undefined;
      const pty = values.pty as boolean | undefined;
      const tryKeyboard = values["try-keyboard"] as boolean | undefined;
      const actualHost = sshConfigEntry?.hostName || host;

      if (!actualHost || !portStr || !username || (!password && !privateKey && !resolvedAgent)) {
        throw new Error(
          "Missing required parameters, need to provide host, port, username and password, private key or agent",
        );
      }
      const port = parseInt(portStr, 10);
      if (isNaN(port)) throw new Error("Port must be a valid number");

      const hostCfg = this.normalizeConfig({
        name: "default",
        host: actualHost,
        port,
        username,
        password,
        privateKey,
        passphrase,
        agent: resolvedAgent,
        proxy: values.proxy as string | undefined,
        socksProxy: values.socksProxy as string | undefined,
        pty: pty !== undefined ? pty : undefined,
        tryKeyboard: tryKeyboard !== undefined ? tryKeyboard : undefined,
        transportMode: values["transport-mode"] as string | undefined,
        shellReadyTimeoutMs: values["shell-ready-timeout"] as string | undefined,
        commandTemplate,
        commandWhitelist: whitelist
          ? whitelist
              .split(",")
              .map((pattern) => pattern.trim())
              .filter(Boolean)
          : undefined,
        commandBlacklist: blacklist
          ? blacklist
              .split(",")
              .map((pattern) => pattern.trim())
              .filter(Boolean)
          : undefined,
        allowedLocalPaths: allowedLocalPaths
          ? allowedLocalPaths
              .split(",")
              .map((allowedPath) => allowedPath.trim())
              .filter(Boolean)
          : undefined,
        allowedRemotePaths: allowedRemotePaths
          ? allowedRemotePaths
              .split(",")
              .map((allowedPath) => allowedPath.trim())
              .filter(Boolean)
          : undefined,
      });

      Logger.log(
        "单机参数已归入 projects.default.environments.default.hosts.default",
        "info",
      );

      return {
        port: DEFAULT_ADMIN_PORT,
        projects: this.buildDefaultHierarchy(hostCfg),
        preConnect: values["pre-connect"] === true,
        admin: values.admin === true,
        adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
        configFile: values["config-file"] ? String(values["config-file"]) : undefined,
      };
    }

    // fallback: empty
    return {
      port: DEFAULT_ADMIN_PORT,
      projects: {},
      preConnect: values["pre-connect"] === true,
      admin: values.admin === true,
      adminPort: values["admin-port"] ? parseInt(String(values["admin-port"]), 10) : undefined,
      configFile: values["config-file"] ? String(values["config-file"]) : undefined,
    };
  }
}

