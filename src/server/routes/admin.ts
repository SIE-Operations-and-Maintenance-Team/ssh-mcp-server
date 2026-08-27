import type { FastifyInstance } from "fastify";
import { ConfigStore, getFlatHosts } from "../../services/config-store.js";
import { ConnectionSchema, GlobalConfigSchema } from "../../models/admin-types.js";
import { DEFAULT_ENVIRONMENTS, DEFAULT_COMMAND_BLACKLIST } from "../../services/defaults.js";
import { Client } from "ssh2";
import fs from "node:fs/promises";
import os from "node:os";

function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isValidIpv6(s: string): boolean {
  if (s.indexOf("::") !== s.lastIndexOf("::")) return false; // `::` 只能出现一次
  if (!/^[0-9a-fA-F:]+$/.test(s) || /:{3,}/.test(s)) return false; // 仅 hex 与冒号，禁止连续 3+ 冒号
  const groups = s.split("::").join(":").split(":").filter(Boolean);
  return groups.length <= 8 && groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

// 校验主机地址：IPv4/IPv6 需合法；主机名/SSH 别名仅拦明显非法字符
function isValidHostAddress(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.includes(":")) return isValidIpv6(v);
  if (/^[\d.]+$/.test(v)) return isValidIpv4(v);
  return !/[\s/\\]/.test(v);
}

// 按 order 数组重排（纯数字键会被 JS 强制升序，故不能依赖对象 key 顺序）
function orderByName<T extends { name: string }>(items: T[], order?: string[]): T[] {
  if (!Array.isArray(order) || order.length === 0) return items;
  const byName: Record<string, T> = {};
  for (const it of items) byName[it.name] = it;
  const out: T[] = [];
  const seen = new Set<string>();
  for (const n of order) if (byName[n] && !seen.has(n)) { out.push(byName[n]); seen.add(n); }
  for (const it of items) if (!seen.has(it.name)) out.push(it);
  return out;
}

function maskHost(host: any): any {
  return host;
}

function maskHosts(hosts: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(hosts || {})) {
    out[k] = maskHost(v);
  }
  return out;
}

function maskProject(proj: any): any {
  if (!proj) return proj;
  const copy: any = { ...proj };
  copy.environments = {};
  for (const [eName, env] of Object.entries((proj.environments || {}) as Record<string, any>)) {
    const eCopy: any = { ...env };
    eCopy.hosts = maskHosts((env as any).hosts);
    copy.environments[eName] = eCopy;
  }
  return copy;
}

function maskEnvironment(env: any): any {
  if (!env) return env;
  const copy: any = { ...env };
  copy.hosts = maskHosts((env as any).hosts);
  return copy;
}

export function registerAdminRoutes(app: FastifyInstance, store: ConfigStore) {
  // GET /admin/api/projects index
  app.get("/admin/api/projects", async () => {
    const cfg: any = await store.load();
    const projects = cfg.projects || {};
    const list = Object.entries(projects).map(([name, proj]: [string, any]) => {
      const envs = proj.environments || {};
      const environmentCount = Object.keys(envs).length;
      let hostCount = 0;
      for (const env of Object.values(envs) as any[]) {
        hostCount += Object.keys((env as any).hosts || {}).length;
      }
      return {
        name,
        displayName: proj.displayName,
        defaultEnvironment: proj.defaultEnvironment,
        environmentCount,
        hostCount,
      };
    });
    return orderByName(list, cfg.projectOrder);
  });

  // POST /admin/api/projects create/update + rename
  app.post("/admin/api/projects", async (req: any, reply: any) => {
    try {
      const body: any = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const originalName = typeof body.originalName === "string" ? body.originalName.trim() : undefined;
      const displayName = body.displayName;
      const defaultEnvironment = body.defaultEnvironment !== undefined && body.defaultEnvironment !== null ? String(body.defaultEnvironment).trim() : undefined;

      if (!name) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `项目名称不能为空: ${name}` };
      }
      if (originalName !== undefined && !originalName) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `项目原名称不能为空: ${originalName}` };
      }
      if (defaultEnvironment !== undefined && !defaultEnvironment) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `环境名称不能为空: ${defaultEnvironment}` };
      }

      const cfg: any = await store.load();
      cfg.projects = cfg.projects || {};

      // atomic rename check
      if (originalName) {
        const source = cfg.projects[originalName];
        if (!source) {
          reply.code(404);
          return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${originalName}` };
        }
        if (originalName !== name && cfg.projects[name]) {
          reply.code(400);
          return { ok: false, code: "HOST_EXISTS", message: `项目已存在: ${name}` };
        }
        // validate defaultEnvironment exists in source (or will exist after)
        const targetDefault = defaultEnvironment !== undefined ? defaultEnvironment : source.defaultEnvironment;
        if (targetDefault && !source.environments?.[targetDefault]) {
          reply.code(400);
          return { ok: false, code: "DEFAULT_ENV_NOT_FOUND", message: `默认环境不存在: ${targetDefault}` };
        }
        // apply updates to source
        if (displayName !== undefined) source.displayName = displayName;
        if (defaultEnvironment !== undefined) source.defaultEnvironment = defaultEnvironment;
        else {
          // 留空则默认为测试环境（若存在）
          if (source.environments && source.environments["测试环境"]) {
            source.defaultEnvironment = "测试环境";
          } else {
            delete source.defaultEnvironment;
          }
        }
        if (!source.environments) source.environments = {};
        if (originalName !== name) {
          cfg.projects[name] = source;
          delete cfg.projects[originalName];
          // 同步 projectOrder，避免重命名后排序位置丢失（掉到列表末尾）
          if (Array.isArray(cfg.projectOrder)) {
            cfg.projectOrder = cfg.projectOrder.map((n: any) => (n === originalName ? name : n));
          }
        }
      } else {
        // 新建项目名称必须唯一（避免同名被当作更新/覆盖）
        if (cfg.projects[name]) {
          reply.code(400);
          return { ok: false, code: "HOST_EXISTS", message: `项目已存在: ${name}` };
        }
        const target: any = { environments: {} };
        // 自动创建默认环境（中文名），用户只需维护主机
        for (const e of DEFAULT_ENVIRONMENTS) {
          target.environments[e] = { displayName: e, hosts: {} };
        }
        if (displayName !== undefined) target.displayName = displayName;
        if (defaultEnvironment !== undefined) target.defaultEnvironment = defaultEnvironment;
        // 未指定则默认 测试环境
        if (!target.defaultEnvironment) target.defaultEnvironment = "测试环境";
        // 若指定的默认环境不在预设 4 个内，自动补一个
        if (target.defaultEnvironment && !target.environments[target.defaultEnvironment]) {
          target.environments[target.defaultEnvironment] = { hosts: {} };
        }
        cfg.projects[name] = target;
      }

      // Validate whole config
      try {
        GlobalConfigSchema.parse(cfg);
      } catch (e: any) {
        reply.code(400);
        return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
      }
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
    }
  });

  // GET /admin/api/projects/:project (masked)
  app.get("/admin/api/projects/:project", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    const proj = cfg.projects?.[req.params.project];
    if (!proj) {
      reply.code(404);
      return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
    }
    return maskProject(proj);
  });

  // DELETE /admin/api/projects/:project
  app.delete("/admin/api/projects/:project", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    if (!cfg.projects?.[req.params.project]) {
      reply.code(404);
      return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
    }
    delete cfg.projects[req.params.project];
    await store.save(cfg);
    return { ok: true };
  });

  // POST /admin/api/projects/:project/environments
  app.post("/admin/api/projects/:project/environments", async (req: any, reply: any) => {
    try {
      const project = req.params.project;
      const body: any = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const originalName = typeof body.originalName === "string" ? body.originalName.trim() : undefined;
      const displayName = body.displayName;

      if (!name) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `环境名称不能为空: ${name}` };
      }
      if (originalName !== undefined && !originalName) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `环境原名称不能为空: ${originalName}` };
      }

      const cfg: any = await store.load();
      const proj = cfg.projects?.[project];
      if (!proj) {
        reply.code(404);
        return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${project}` };
      }
      proj.environments = proj.environments || {};

      if (originalName) {
        const source = proj.environments[originalName];
        if (!source) {
          reply.code(404);
          return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${originalName}` };
        }
        if (originalName !== name && proj.environments[name]) {
          reply.code(400);
          return { ok: false, code: "HOST_EXISTS", message: `环境已存在: ${name}` };
        }
        if (displayName !== undefined) source.displayName = displayName;
        if (originalName !== name) {
          proj.environments[name] = source;
          delete proj.environments[originalName];
          // if defaultEnvironment pointed to old name, update it
          if (proj.defaultEnvironment === originalName) proj.defaultEnvironment = name;
        }
      } else {
        if (proj.environments[name]) {
          reply.code(400);
          return { ok: false, code: "HOST_EXISTS", message: `环境已存在: ${name}` };
        }
        const target: any = { hosts: {} };
        if (displayName !== undefined) target.displayName = displayName;
        proj.environments[name] = target;
      }

      try {
        GlobalConfigSchema.parse(cfg);
      } catch (e: any) {
        reply.code(400);
        return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
      }
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
    }
  });

  // GET /admin/api/projects/:project/environments/:env (masked)
  app.get("/admin/api/projects/:project/environments/:env", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    const proj = cfg.projects?.[req.params.project];
    if (!proj) {
      reply.code(404);
      return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
    }
    const env = proj.environments?.[req.params.env];
    if (!env) {
      reply.code(404);
      return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${req.params.env}` };
    }
    return maskEnvironment(env);
  });

  // DELETE /admin/api/projects/:project/environments/:env
  app.delete("/admin/api/projects/:project/environments/:env", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    const proj = cfg.projects?.[req.params.project];
    if (!proj) {
      reply.code(404);
      return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
    }
    if (!proj.environments?.[req.params.env]) {
      reply.code(404);
      return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${req.params.env}` };
    }
    delete proj.environments[req.params.env];
    if (proj.defaultEnvironment === req.params.env) delete proj.defaultEnvironment;
    await store.save(cfg);
    return { ok: true };
  });

  // POST /admin/api/projects/:project/environments/:env/hosts
  app.post("/admin/api/projects/:project/environments/:env/hosts", async (req: any, reply: any) => {
    try {
      const project = req.params.project;
      const envName = req.params.env;
      const body: any = req.body || {};
      const rawOriginal = typeof body.originalName === "string" ? body.originalName.trim() : undefined;
      const hostKey = typeof body.name === "string" ? body.name.trim() : "";

      if (!hostKey) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `主机名称不能为空: ${hostKey}` };
      }
      if (rawOriginal !== undefined && !rawOriginal) {
        reply.code(400);
        return { ok: false, code: "INVALID_NAME", message: `主机原名称不能为空: ${rawOriginal}` };
      }

      const cfg: any = await store.load();
      const proj = cfg.projects?.[project];
      if (!proj) {
        reply.code(404);
        return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${project}` };
      }
      const env = proj.environments?.[envName];
      if (!env) {
        reply.code(404);
        return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${envName}` };
      }
      env.hosts = env.hosts || {};

      // 校验主机地址格式（IPv4/IPv6/主机名或 SSH 别名）
      const hostValue = typeof body.host === "string" ? body.host.trim() : "";
      if (!hostValue || !isValidHostAddress(hostValue)) {
        reply.code(400);
        return { ok: false, code: "INVALID_ADDRESS", message: "主机地址格式不正确" };
      }

      const lookupKey = rawOriginal || hostKey;
      const existing = env.hosts[lookupKey];

      // 新建或重命名到已存在的名称时拒绝，避免覆盖；自身原地保存放行
      if (env.hosts[hostKey] && rawOriginal !== hostKey) {
        reply.code(400);
        return { ok: false, code: "HOST_EXISTS", message: `主机已存在: ${hostKey}` };
      }

      // prepare data for validation/normalization
      const toParse: any = { ...body };
      delete toParse.originalName;
      toParse.name = hostKey;

      let parsed: any;
      try {
        parsed = ConnectionSchema.passthrough().parse(toParse);
      } catch (e: any) {
        reply.code(400);
        return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
      }

      const { CommandLineParser } = await import("../../cli/command-line-parser.js");
      const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
      normalized.name = hostKey;

      // 修复 #3：清空后应跟随全局（undefined），而非固化默认值
      if (parsed.transportMode === undefined) delete normalized.transportMode;
      if (parsed.shellReadyTimeoutMs === undefined) delete normalized.shellReadyTimeoutMs;

      // Handle password/passphrase retention: if frontend sent "***" treat as missing
      if (normalized.password === "***") delete normalized.password;
      if (normalized.passphrase === "***") delete normalized.passphrase;

      if (!normalized.password && existing?.password) normalized.password = existing.password;
      if (!normalized.passphrase && existing?.passphrase) normalized.passphrase = existing.passphrase;

      env.hosts[hostKey] = normalized;
      if (rawOriginal && rawOriginal !== hostKey) {
        delete env.hosts[rawOriginal];
      }

      try {
        GlobalConfigSchema.parse(cfg);
      } catch (e: any) {
        reply.code(400);
        return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
      }
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
    }
  });

  // DELETE /admin/api/projects/:project/environments/:env/hosts/:host
  app.delete("/admin/api/projects/:project/environments/:env/hosts/:host", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    const proj = cfg.projects?.[req.params.project];
    if (!proj) {
      reply.code(404);
      return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
    }
    const env = proj.environments?.[req.params.env];
    if (!env) {
      reply.code(404);
      return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${req.params.env}` };
    }
    if (!env.hosts?.[req.params.host]) {
      reply.code(404);
      return { ok: false, code: "HOST_NOT_FOUND", message: `主机不存在: ${req.params.host}` };
    }
    delete env.hosts[req.params.host];
    await store.save(cfg);
    return { ok: true };
  });

  // POST /admin/api/projects/reorder 项目拖拽排序（写入 projectOrder 数组持久化）
  app.post("/admin/api/projects/reorder", async (req: any, reply: any) => {
    try {
      const order: string[] = req.body?.order;
      if (!Array.isArray(order)) {
        reply.code(400);
        return { ok: false, code: "INVALID_ORDER", message: "order 必须是数组" };
      }
      const cfg: any = await store.load();
      const projects: Record<string, any> = cfg.projects || {};
      // 用显式 projectOrder 数组持久化顺序（对象 key 对纯数字名会重排，不能依赖）
      const seen: string[] = [];
      for (const name of order) if (typeof name === "string" && projects[name] && !seen.includes(name)) seen.push(name);
      for (const name of Object.keys(projects)) if (!seen.includes(name)) seen.push(name);
      cfg.projectOrder = seen;
      GlobalConfigSchema.parse(cfg);
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
    }
  });

  // POST /admin/api/projects/:project/environments/:env/hosts/reorder 主机拖拽排序（写入 hostOrder 数组持久化）
  app.post("/admin/api/projects/:project/environments/:env/hosts/reorder", async (req: any, reply: any) => {
    try {
      const order: string[] = req.body?.order;
      if (!Array.isArray(order)) {
        reply.code(400);
        return { ok: false, code: "INVALID_ORDER", message: "order 必须是数组" };
      }
      const cfg: any = await store.load();
      const proj = cfg.projects?.[req.params.project];
      if (!proj) {
        reply.code(404);
        return { ok: false, code: "PROJECT_NOT_FOUND", message: `项目不存在: ${req.params.project}` };
      }
      const env = proj.environments?.[req.params.env];
      if (!env) {
        reply.code(404);
        return { ok: false, code: "ENVIRONMENT_NOT_FOUND", message: `环境不存在: ${req.params.env}` };
      }
      env.hosts = env.hosts || {};
      // 用显式 hostOrder 数组持久化顺序
      const seen: string[] = [];
      for (const name of order) if (typeof name === "string" && env.hosts[name] && !seen.includes(name)) seen.push(name);
      for (const name of Object.keys(env.hosts)) if (!seen.includes(name)) seen.push(name);
      env.hostOrder = seen;
      GlobalConfigSchema.parse(cfg);
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "VALIDATION_ERROR", message: String(e?.message || e) };
    }
  });
  app.get("/admin/api/connections", async () => {
    const cfg: any = await store.load();
    const flat = getFlatHosts(cfg);
    const masked: Record<string, any> = {};
    for (const [flatName, { config }] of flat) {
      masked[flatName] = maskHost(config);
    }
    return masked;
  });

  // GET /admin/api/config/export (unmasked full)
  app.get("/admin/api/config/export", async () => {
    const cfg: any = await store.load();
    // return full config unmasked, include projects and legacy connections for compat
    const flat = getFlatHosts(cfg);
    const connections: Record<string, any> = {};
    for (const [flatName, { config }] of flat) {
      connections[flatName] = config;
    }
    return {
      projects: cfg.projects || {},
      connections,
      port: cfg.port,
      audit: cfg.audit,
      backups: cfg.backups,
      security: cfg.security,
      preConnect: cfg.preConnect,
    };
  });

  // POST /admin/api/config/import
  app.post("/admin/api/config/import", async (req: any, reply: any) => {
    try {
      const body: any = req.body || {};
      const cfg: any = await store.load();
      cfg.projects = cfg.projects || {};
      let addedProjects = 0;
      let updatedProjects = 0;
      let addedEnvironments = 0;
      let addedHosts = 0;
      const warnings: string[] = [];

      const hasProjects = body.projects && typeof body.projects === "object" && Object.keys(body.projects).length > 0;
      const hasConnections = body.connections !== undefined && body.connections !== null;

      if (hasProjects) {
        // merge projects
        for (const [pName, pVal] of Object.entries(body.projects as Record<string, any>)) {
          if (!pName || !pName.trim()) {
            warnings.push(`跳过非法项目名: ${pName}`);
            continue;
          }
          const isNew = !cfg.projects[pName];
          if (isNew) addedProjects++;
          else updatedProjects++;

          const pValAny: any = pVal || {};
          const newEnvs: Record<string, any> = pValAny.environments || {};

          if (isNew) {
            // normalize hosts for new project
            const newProj: any = { ...pValAny, environments: {} };
            for (const [eName, eVal] of Object.entries(newEnvs)) {
              if (!eName || !eName.trim()) {
                warnings.push(`跳过非法环境名: ${eName}`);
                continue;
              }
              const eValAny: any = eVal || {};
              const newHosts: Record<string, any> = eValAny.hosts || {};
              const normalizedHosts: Record<string, any> = {};
              for (const [hName, hVal] of Object.entries(newHosts)) {
                if (!hName || !hName.trim()) {
                  warnings.push(`跳过非法主机名: ${hName}`);
                  continue;
                }
                try {
                  const parsed = ConnectionSchema.passthrough().parse({ ...(hVal as any), name: hName });
                  const { CommandLineParser } = await import("../../cli/command-line-parser.js");
                  const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
                  normalized.name = hName;
                  normalizedHosts[hName] = normalized;
                  addedHosts++;
                } catch (e: any) {
                  warnings.push(`跳过非法主机 ${hName}: ${String(e?.message || e)}`);
                }
              }
              newProj.environments[eName] = { ...eValAny, hosts: normalizedHosts };
              addedEnvironments++;
            }
            cfg.projects[pName] = newProj;
          } else {
            // merge into existing
            const target = cfg.projects[pName];
            if (pValAny.displayName !== undefined) target.displayName = pValAny.displayName;
            if (pValAny.defaultEnvironment !== undefined) target.defaultEnvironment = pValAny.defaultEnvironment;
            target.environments = target.environments || {};
            for (const [eName, eVal] of Object.entries(newEnvs)) {
              if (!eName || !eName.trim()) {
                warnings.push(`跳过非法环境名: ${eName}`);
                continue;
              }
              const eValAny: any = eVal || {};
              const newHosts: Record<string, any> = eValAny.hosts || {};
              if (!target.environments[eName]) {
                // new environment
                const normalizedHosts: Record<string, any> = {};
                for (const [hName, hVal] of Object.entries(newHosts)) {
                  if (!hName || !hName.trim()) {
                    warnings.push(`跳过非法主机名: ${hName}`);
                    continue;
                  }
                  try {
                    const parsed = ConnectionSchema.passthrough().parse({ ...(hVal as any), name: hName });
                    const { CommandLineParser } = await import("../../cli/command-line-parser.js");
                    const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
                    normalized.name = hName;
                    normalizedHosts[hName] = normalized;
                    addedHosts++;
                  } catch (e: any) {
                    warnings.push(`跳过非法主机 ${hName}: ${String(e?.message || e)}`);
                  }
                }
                target.environments[eName] = { ...eValAny, hosts: normalizedHosts };
                addedEnvironments++;
              } else {
                const tEnv = target.environments[eName];
                if (eValAny.displayName !== undefined) tEnv.displayName = eValAny.displayName;
                tEnv.hosts = tEnv.hosts || {};
                for (const [hName, hVal] of Object.entries(newHosts)) {
                  if (!hName || !hName.trim()) {
                    warnings.push(`跳过非法主机名: ${hName}`);
                    continue;
                  }
                  const isNewHost = !tEnv.hosts[hName];
                  try {
                    const parsed = ConnectionSchema.passthrough().parse({ ...(hVal as any), name: hName });
                    const { CommandLineParser } = await import("../../cli/command-line-parser.js");
                    const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
                    normalized.name = hName;
                    tEnv.hosts[hName] = normalized;
                    if (isNewHost) addedHosts++;
                  } catch (e: any) {
                    warnings.push(`跳过非法主机 ${hName}: ${String(e?.message || e)}`);
                  }
                }
              }
            }
          }
        }
        if (hasConnections) {
          warnings.push("检测到旧格式 connections，已忽略以 projects 为准");
        }
      } else if (hasConnections) {
        warnings.push("检测到旧格式 connections，已自动归入 default/default");
        if (!cfg.projects.default) {
          cfg.projects.default = { displayName: "默认项目", environments: {} };
          addedProjects++;
        }
        if (!cfg.projects.default.environments) cfg.projects.default.environments = {};
        if (!cfg.projects.default.environments.default) {
          cfg.projects.default.environments.default = { displayName: "默认环境", hosts: {} };
          addedEnvironments++;
        }
        const targetHosts = cfg.projects.default.environments.default.hosts;
        const raw = body.connections;
        let list: Array<{ key?: string; val: any }> = [];
        if (Array.isArray(raw)) {
          list = raw.map((v: any) => ({ val: v }));
        } else if (typeof raw === "object") {
          list = Object.entries(raw as Record<string, any>).map(([k, v]) => ({ key: k, val: v }));
        }
        const { CommandLineParser } = await import("../../cli/command-line-parser.js");
        for (const { key, val } of list) {
          const inferredName = (val && typeof val.name === "string" && val.name.trim()) ? val.name.trim() : key?.trim();
          if (!inferredName) {
            warnings.push(`跳过非法主机名: ${inferredName || "(empty)"}`);
            continue;
          }
          try {
            const parsed = ConnectionSchema.passthrough().parse({ ...val, name: inferredName });
            const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
            normalized.name = inferredName;
            if (!targetHosts[inferredName]) addedHosts++;
            targetHosts[inferredName] = normalized;
          } catch (e: any) {
            warnings.push(`跳过非法主机 ${inferredName}: ${String(e?.message || e)}`);
          }
        }
      } else {
        // also support body itself being connections (legacy direct array/record)
        // Check if body looks like connections: array of hosts or flat record with host/port
        const looksLikeConnections = Array.isArray(body) || (typeof body === "object" && Object.values(body).some((v: any) => v && typeof v === "object" && "host" in v));
        if (looksLikeConnections) {
          warnings.push("检测到旧格式 connections，已自动归入 default/default");
          if (!cfg.projects.default) {
            cfg.projects.default = { displayName: "默认项目", environments: {} };
            addedProjects++;
          }
          if (!cfg.projects.default.environments) cfg.projects.default.environments = {};
          if (!cfg.projects.default.environments.default) {
            cfg.projects.default.environments.default = { displayName: "默认环境", hosts: {} };
            addedEnvironments++;
          }
          const targetHosts = cfg.projects.default.environments.default.hosts;
          const raw = body;
          let list: Array<{ key?: string; val: any }> = [];
          if (Array.isArray(raw)) list = raw.map((v: any) => ({ val: v }));
          else list = Object.entries(raw as Record<string, any>).map(([k, v]) => ({ key: k, val: v }));
          const { CommandLineParser } = await import("../../cli/command-line-parser.js");
          for (const { key, val } of list) {
            const inferredName = (val && typeof val.name === "string" && val.name.trim()) ? val.name.trim() : key?.trim();
            if (!inferredName) {
              warnings.push(`跳过非法主机名: ${inferredName || "(empty)"}`);
              continue;
            }
            try {
              const parsed = ConnectionSchema.passthrough().parse({ ...val, name: inferredName });
              const normalized: any = (CommandLineParser as any).normalizeConfig(parsed);
              normalized.name = inferredName;
              if (!targetHosts[inferredName]) addedHosts++;
              targetHosts[inferredName] = normalized;
            } catch (e: any) {
              warnings.push(`跳过非法主机 ${inferredName}: ${String(e?.message || e)}`);
            }
          }
        } else {
          reply.code(400);
          return { ok: false, code: "INVALID_IMPORT", message: "导入数据为空或格式不正确", warnings };
        }
      }

      try {
        GlobalConfigSchema.parse(cfg);
      } catch (e: any) {
        reply.code(400);
        return { ok: false, code: "INVALID_IMPORT", message: String(e?.message || e), warnings };
      }
      await store.save(cfg);
      return { ok: true, addedProjects, updatedProjects, addedEnvironments, addedHosts, warnings, count: addedHosts };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "INVALID_IMPORT", message: String(e?.message || e) };
    }
  });

  // legacy flat POST /admin/api/connections (keep for compat, but now operates on default/default)
  app.post("/admin/api/connections", async (req: any, reply: any) => {
    try {
      const body: any = req.body;
      const parsed = ConnectionSchema.passthrough().parse(body);
      const { CommandLineParser } = await import("../../cli/command-line-parser.js");
      const normalized = (CommandLineParser as any).normalizeConfig(parsed);
      const cfg: any = await store.load();
      cfg.projects = cfg.projects || {};
      if (!cfg.projects.default) cfg.projects.default = { displayName: "默认项目", environments: {} };
      if (!cfg.projects.default.environments) cfg.projects.default.environments = {};
      if (!cfg.projects.default.environments.default) cfg.projects.default.environments.default = { displayName: "默认环境", hosts: {} };
      const hosts = cfg.projects.default.environments.default.hosts;
      const existing: any = hosts[normalized.name];
      if (existing) {
        if (!normalized.password && existing.password) normalized.password = existing.password;
        if (!normalized.passphrase && existing.passphrase) normalized.passphrase = existing.passphrase;
      }
      hosts[normalized.name] = normalized;
      await store.save(cfg);
      return { ok: true };
    } catch (e: any) {
      reply.code(400);
      return { ok: false, code: "INVALID_CONNECTION", message: String(e?.message || e), retriable: false };
    }
  });

  app.delete("/admin/api/connections/:name", async (req: any, reply: any) => {
    const cfg: any = await store.load();
    // try to find flat host by name across projects
    const flat = getFlatHosts(cfg);
    let targetFlat: string | null = null;
    if (flat.has(req.params.name)) targetFlat = req.params.name;
    else {
      const candidates: string[] = [];
      for (const [k, v] of flat) if (v.host === req.params.name) candidates.push(k);
      if (candidates.length === 1) targetFlat = candidates[0];
    }
    if (targetFlat) {
      const [p, e, h] = targetFlat.split("/");
      delete cfg.projects[p]?.environments?.[e]?.hosts?.[h];
      await store.save(cfg);
      return { ok: true };
    }
    // fallback: delete from default/default if exists
    if (cfg.projects?.default?.environments?.default?.hosts?.[req.params.name]) {
      delete cfg.projects.default.environments.default.hosts[req.params.name];
      await store.save(cfg);
      return { ok: true };
    }
    reply.code(404);
    return { ok: false, code: "HOST_NOT_FOUND", message: `主机不存在: ${req.params.name}` };
  });

  app.get("/admin/api/security", async () => {
    const cfg: any = await store.load();
    return cfg.security || { commandWhitelist: [], commandBlacklist: [...DEFAULT_COMMAND_BLACKLIST], allowedLocalPaths: [], allowedRemotePaths: [] };
  });

  // 全局默认值（唯一来源 services/defaults.ts），供前端下拉选项/恢复默认等场景取用
  app.get("/admin/api/defaults", async () => {
    return {
      defaultEnvironments: [...DEFAULT_ENVIRONMENTS],
      defaultCommandBlacklist: [...DEFAULT_COMMAND_BLACKLIST],
    };
  });

  app.post("/admin/api/security", async (req: any, reply: any) => {
    const body: any = req.body || {};
    const normalizeList = (arr: any): string[] => {
      if (!arr) return [];
      const list: string[] = Array.isArray(arr) ? arr : String(arr).split("\n");
      return list.map((s:string)=>s.trim()).filter(Boolean).map((s:string)=>{
        const p = s.startsWith("^") ? s : "^"+s;
        try { new RegExp(p); } catch { throw new Error("正则格式不正确: "+s); }
        return p;
      });
    };
    const parsePaths = (v:any): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map((s:string)=>String(s).trim()).filter(Boolean);
      return String(v).split(",").map((s:string)=>s.trim()).filter(Boolean);
    };
    try {
      const security = {
        commandWhitelist: normalizeList(body.commandWhitelist ?? body.whitelist),
        commandBlacklist: normalizeList(body.commandBlacklist ?? body.blacklist),
        allowedLocalPaths: parsePaths(body.allowedLocalPaths),
        allowedRemotePaths: parsePaths(body.allowedRemotePaths),
      };
      const cfg: any = await store.load();
      cfg.security = security;
      await store.save(cfg);
      return { ok: true, security };
    } catch(e:any){
      reply.code(400);
      return { ok:false, code:"INVALID_SECURITY", message: String(e.message) };
    }
  });

  app.post("/admin/api/test-connection", async (req: any) => {
    const conf: any = req.body || {};
    const start = Date.now();
    // 支持密码 / 私钥（路径，~ 展开）/ agent 三种认证，与主机配置保持一致
    const connectOpts: any = { host: conf.host, port: conf.port ?? 22, username: conf.username, readyTimeout: 7000 };
    if (conf.password) connectOpts.password = conf.password;
    if (conf.privateKey) {
      try {
        const keyPath = conf.privateKey.replace(/^~(?=$|[\\/])/, os.homedir());
        connectOpts.privateKey = await fs.readFile(keyPath, "utf-8");
        if (conf.passphrase) connectOpts.passphrase = conf.passphrase;
      } catch {
        return { ok: false, code: "KEY_READ_FAILED", message: `无法读取私钥: ${conf.privateKey}`, retriable: false };
      }
    } else if (conf.agent) {
      connectOpts.agent = conf.agent;
    }
    return await new Promise((resolve) => {
      const conn = new Client();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          conn.end();
          resolve({ ok: false, code: "TIMEOUT", message: "timeout", retriable: true });
        }
      }, 8000);
      conn
        .on("ready", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          conn.end();
          resolve({ ok: true, latencyMs: Date.now() - start });
        })
        .on("error", (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, code: "CONNECT_FAILED", message: String(e.message), retriable: true });
        })
        .connect(connectOpts);
    });
  });
}
