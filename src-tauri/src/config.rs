//! 分层配置读写：`projects → environments → hosts` + security/audit/backups/port。
//!
//! 路径与 npm 版（@sieop/ssh-mcp-server）完全一致：
//! - Windows: `%ProgramData%\SshMcpServer\config.json`
//! - 其他:    `$XDG_CONFIG_HOME|~/.config/ssh-mcp-server/config.json`
//!
//! 字段名用 camelCase（serde rename_all），与 Node 版 schema 互通；
//! 原子写（tmp + rename）语义对齐 ConfigStore.save()。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const DEFAULT_ADMIN_PORT: u16 = 61823;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    #[serde(default)]
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub try_keyboard: Option<bool>,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub socks_proxy: Option<String>,
    #[serde(default)]
    pub pty: Option<bool>,
    #[serde(default)]
    pub transport_mode: Option<String>, // exec | shell
    #[serde(default)]
    pub shell_ready_timeout_ms: Option<u64>,
    #[serde(default)]
    pub shell_command_timeout_ms: Option<u64>,
    #[serde(default)]
    pub command_timeout_ms: Option<u64>,
    #[serde(default)]
    pub connection_timeout_ms: Option<u64>,
    #[serde(default)]
    pub sftp_timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_output_bytes: Option<u64>,
    #[serde(default)]
    pub keepalive_interval_ms: Option<u32>,
    #[serde(default)]
    pub keepalive_count_max: Option<u32>,
    #[serde(default)]
    pub command_template: Option<String>,
    #[serde(default)]
    pub command_whitelist: Option<Vec<String>>,
    #[serde(default)]
    pub command_blacklist: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_local_paths: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_remote_paths: Option<Vec<String>>,
}

impl HostConfig {
    /// 展开后的命令超时（毫秒），默认 30000（对齐 Node 版 DEFAULT_COMMAND_TIMEOUT_MS）
    pub fn effective_command_timeout(&self) -> u64 {
        self.command_timeout_ms.unwrap_or(30_000)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentConfig {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub host_order: Vec<String>,
    #[serde(default)]
    pub hosts: BTreeMap<String, HostConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub default_environment: Option<String>,
    #[serde(default)]
    pub environments: BTreeMap<String, EnvironmentConfig>,
}

/// 全局兜底安全策略（白名单留空跟随；黑名单并集）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    #[serde(default)]
    pub command_whitelist: Option<Vec<String>>,
    #[serde(default)]
    pub command_blacklist: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_local_paths: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_remote_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditSettings {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub log_results: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    #[serde(default)]
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub max_count: Option<u32>,
    #[serde(default)]
    pub auto_enabled: Option<bool>,
    #[serde(default)]
    pub interval_hours: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfig {
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectConfig>,
    #[serde(default)]
    pub project_order: Vec<String>,
    #[serde(default)]
    pub audit: Option<AuditSettings>,
    #[serde(default)]
    pub backups: Option<BackupSettings>,
    #[serde(default)]
    pub security: Option<SecurityConfig>,
    #[serde(default)]
    pub pre_connect: Option<bool>,
}

impl GlobalConfig {
    pub fn admin_port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_ADMIN_PORT)
    }

    /// 主机名归一化：hosts map 的 key 是唯一权威标识，历史导入（如 PublishTools
    /// 同步）的数据对象内 name 可能为空串，统一用 key 回填。幂等，返回是否有修改。
    pub fn normalize_host_names(&mut self) -> bool {
        let mut changed = false;
        for proj in self.projects.values_mut() {
            for env in proj.environments.values_mut() {
                for (h_name, hc) in env.hosts.iter_mut() {
                    if hc.name.trim().is_empty() && !h_name.trim().is_empty() {
                        hc.name = h_name.clone();
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    /// 展开 `project/env/host → HostConfig`（键为 `p/e/h` 扁平名），
    /// 并应用全局安全兜底：白名单/路径连接级留空则跟随全局，黑名单取并集。
    pub fn flatten_hosts(&self) -> BTreeMap<String, (String, String, String, HostConfig)> {
        let mut out = BTreeMap::new();
        let sec = self.security.clone().unwrap_or_default();
        for (p_name, proj) in &self.projects {
            for (e_name, env) in &proj.environments {
                for (h_name, h) in &env.hosts {
                    let mut c = h.clone();
                    if c.command_whitelist.as_ref().map_or(true, |v| v.is_empty()) {
                        if let Some(wl) = &sec.command_whitelist {
                            if !wl.is_empty() {
                                c.command_whitelist = Some(wl.clone());
                            }
                        }
                    }
                    // 黑名单并集：全局高危拦截不能被连接级清空
                    match (&sec.command_blacklist, &h.command_blacklist) {
                        (Some(g), Some(l)) => {
                            let mut merged = g.clone();
                            merged.extend(l.clone());
                            c.command_blacklist = Some(merged);
                        }
                        (Some(g), None) => c.command_blacklist = Some(g.clone()),
                        _ => {}
                    }
                    if c.allowed_local_paths.as_ref().map_or(true, |v| v.is_empty()) {
                        if let Some(lp) = &sec.allowed_local_paths {
                            if !lp.is_empty() {
                                c.allowed_local_paths = Some(lp.clone());
                            }
                        }
                    }
                    if c.allowed_remote_paths.as_ref().map_or(true, |v| v.is_empty()) {
                        if let Some(rp) = &sec.allowed_remote_paths {
                            if !rp.is_empty() {
                                c.allowed_remote_paths = Some(rp.clone());
                            }
                        }
                    }
                    out.insert(
                        format!("{}/{}", format!("{}/{}", p_name, e_name), h_name),
                        (
                            p_name.clone(),
                            e_name.clone(),
                            h_name.clone(),
                            c,
                        ),
                    );
                }
            }
        }
        out
    }

    /// 按名称解析连接：支持 `p/e/h` 全路径或全局唯一主机名简写
    pub fn resolve_connection(&self, name: &str) -> Result<(String, HostConfig), String> {
        let flat = self.flatten_hosts();
        if let Some((_, _, _, cfg)) = flat.get(name) {
            return Ok((name.to_string(), cfg.clone()));
        }
        // 简写：按主机名匹配
        let candidates: Vec<_> = flat
            .iter()
            .filter(|(_, (_, _, h, _))| h == name)
            .collect();
        match candidates.len() {
            1 => Ok((
                candidates[0].0.clone(),
                candidates[0].1 .3.clone(),
            )),
            0 => Err(format!("SSH configuration for '{}' not set", name)),
            _ => Err(format!(
                "Ambiguous host '{}': {} matches",
                name,
                candidates.len()
            )),
        }
    }
}

/// 配置文件路径（与 npm 版 getGlobalConfigPath 一致）
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("SSH_MCP_CONFIG") {
        return PathBuf::from(p);
    }
    if cfg!(windows) {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(base).join("SshMcpServer").join("config.json")
    } else {
        let xdg =
            std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{}/.config", home_dir()));
        PathBuf::from(xdg).join("ssh-mcp-server").join("config.json")
    }
}

fn home_dir() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_else(|_| ".".into())
}

/// 加载配置；不存在返回默认值（port=61823），损坏时同样落回默认并打印告警
pub fn load() -> GlobalConfig {
    let mut cfg = load_raw();
    // 读兜底：存量脏数据（对象内 name 为空）统一用 key 回填，保证所有读路径拿到一致数据
    cfg.normalize_host_names();
    cfg
}

/// 读取原始配置（不做归一化，供迁移判断原始数据是否脏）
fn load_raw() -> GlobalConfig {
    let path = config_path();
    if !path.exists() {
        return GlobalConfig {
            port: Some(DEFAULT_ADMIN_PORT),
            ..Default::default()
        };
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[config] 配置解析失败: {e}，使用默认配置");
            GlobalConfig {
                port: Some(DEFAULT_ADMIN_PORT),
                ..Default::default()
            }
        }),
        Err(e) => {
            eprintln!("[config] 读取失败: {e}");
            GlobalConfig {
                port: Some(DEFAULT_ADMIN_PORT),
                ..Default::default()
            }
        }
    }
}

/// 启动迁移：治愈存量脏数据（name 为空的主机回填 key）并落盘；数据干净时不写盘
pub fn migrate() {
    let mut cfg = load_raw();
    if !cfg.normalize_host_names() {
        return;
    }
    match save(&cfg) {
        Ok(()) => eprintln!("[config] 已修复主机名称缺失的存量数据"),
        Err(e) => eprintln!("[config] 存量数据修复写入失败: {e}"),
    }
}

/// 原子保存（.bak 备份 + tmp + rename，对齐 Node ConfigStore.save）
pub fn save(cfg: &GlobalConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&tmp, &json).map_err(|e| format!("写入临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换配置文件失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> HostConfig {
        HostConfig {
            name: name.to_string(),
            host: "127.0.0.1".into(),
            port: 22,
            username: "root".into(),
            ..Default::default()
        }
    }

    fn cfg_with_hosts(pairs: &[(&str, &str)]) -> GlobalConfig {
        // pairs: (key, 对象内 name)
        let mut env = EnvironmentConfig::default();
        for (k, n) in pairs {
            env.hosts.insert(k.to_string(), host(n));
        }
        let mut proj = ProjectConfig::default();
        proj.environments.insert("导入".into(), env);
        let mut cfg = GlobalConfig::default();
        cfg.projects.insert("p1".into(), proj);
        cfg
    }

    #[test]
    fn normalize_fills_empty_names_from_key() {
        let mut cfg = cfg_with_hosts(&[("扬兴-正式环境", ""), ("广州", "广州")]);
        assert!(cfg.normalize_host_names());
        let hosts = &cfg.projects["p1"].environments["导入"].hosts;
        assert_eq!(hosts["扬兴-正式环境"].name, "扬兴-正式环境");
        assert_eq!(hosts["广州"].name, "广州"); // 已有 name 不动
    }

    #[test]
    fn normalize_is_idempotent() {
        let mut cfg = cfg_with_hosts(&[("a", ""), ("b", "b")]);
        assert!(cfg.normalize_host_names());
        assert!(!cfg.normalize_host_names()); // 第二次无修改
    }

    #[test]
    fn normalize_skips_blank_key() {
        // key 本身为空白时不回填（空白 key 属非法数据，由导入侧告警拦截）
        let mut cfg = cfg_with_hosts(&[("  ", "")]);
        assert!(!cfg.normalize_host_names());
        assert_eq!(cfg.projects["p1"].environments["导入"].hosts["  "].name, "");
    }
}
