import { z } from "zod";

// 管理端口默认值的唯一来源：models 层定义，services/server/cli 各处引用，避免多处写死漂移
export const DEFAULT_ADMIN_PORT = 61823;

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout/setInterval 32-bit signed int 上限
const timeout = z.number().int().positive().max(MAX_TIMEOUT_MS).optional();

export const ConnectionSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    agent: z.string().optional(),
    tryKeyboard: z.boolean().optional(),
    proxy: z.string().optional(),
    socksProxy: z.string().optional(),
    pty: z.boolean().optional(),
    transportMode: z.enum(["exec", "shell"]).optional(),
    shellReadyTimeoutMs: timeout,
    shellCommandTimeoutMs: timeout,
    commandTimeoutMs: timeout,
    connectionTimeoutMs: timeout,
    sftpTimeoutMs: timeout,
    maxOutputBytes: z.number().int().min(0).optional(),
    keepaliveIntervalMs: timeout,
    keepaliveCountMax: timeout,
    commandTemplate: z
      .string()
      .optional()
      .refine(
        (v) => !v || v.includes("<command>") || v.includes("<quotedCommand>"),
        "commandTemplate 必须包含 <command> 或 <quotedCommand>",
      ),
    allowedLocalPaths: z.array(z.string()).optional(),
    allowedRemotePaths: z
      .array(z.string())
      .optional()
      .refine(
        (v) => !v || v.every((p) => p.startsWith("/")),
        "远端路径必须为绝对 POSIX 路径",
      ),
    commandWhitelist: z
      .array(z.string())
      .optional()
      .refine(
        (v) =>
          !v ||
          v.every((s) => {
            try {
              new RegExp(s);
              return true;
            } catch {
              return false;
            }
          }),
        "正则格式不正确",
      ),
    commandBlacklist: z
      .array(z.string())
      .optional()
      .refine(
        (v) =>
          !v ||
          v.every((s) => {
            try {
              new RegExp(s);
              return true;
            } catch {
              return false;
            }
          }),
        "正则格式不正确",
      ),
    algorithms: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const HostSchema = ConnectionSchema;

export const EnvironmentSchema = z
  .object({
    displayName: z.string().max(100).optional(),
    hostOrder: z.array(z.string()).optional(),
    hosts: z.record(z.string().min(1), HostSchema),
  })
  .passthrough();

export const ProjectSchema = z
  .object({
    displayName: z.string().max(100).optional(),
    defaultEnvironment: z.string().min(1).optional(),
    environments: z.record(z.string().min(1), EnvironmentSchema).default({}),
  })
  .passthrough()
  .superRefine((p, ctx) => {
    if (p.defaultEnvironment && !p.environments[p.defaultEnvironment]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultEnvironment"], message: "默认环境不存在" });
    }
  });

export const SettingsSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).optional(),
  preConnect: z.boolean().optional(),
  audit: z
    .object({
      enabled: z.boolean().optional(),
      retentionDays: z.number().int().min(1).max(365).optional(),
      logResults: z.boolean().optional(),
    })
    .optional(),
  backups: z
    .object({
      retentionDays: z.number().int().min(1).max(365).optional(),
      maxCount: z.number().int().min(1).optional(),
      autoEnabled: z.boolean().optional(),
      intervalHours: z.number().int().min(1).max(720).optional(),
    })
    .optional(),
});

export const GlobalConfigSchema = z.object({
  port: z.number().int().min(0).max(65535).default(DEFAULT_ADMIN_PORT),
  projects: z.record(z.string().min(1), ProjectSchema).default({}),
  projectOrder: z.array(z.string()).optional(),
  audit: z
    .object({
      enabled: z.boolean().optional(),
      retentionDays: z.number().int().min(1).max(365).optional(),
      logResults: z.boolean().optional(),
    })
    .optional(),
  backups: z
    .object({
      retentionDays: z.number().int().min(1).max(365).optional(),
      maxCount: z.number().int().min(1).optional(),
      autoEnabled: z.boolean().optional(),
      intervalHours: z.number().int().min(1).max(720).optional(),
    })
    .optional(),
  security: z
    .object({
      commandWhitelist: z.array(z.string()).optional(),
      commandBlacklist: z.array(z.string()).optional(),
      allowedLocalPaths: z.array(z.string()).optional(),
      allowedRemotePaths: z.array(z.string()).optional(),
    })
    .optional(),
  preConnect: z.boolean().optional(),
});

export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;
export type GlobalConfigInput = z.infer<typeof GlobalConfigSchema>;
