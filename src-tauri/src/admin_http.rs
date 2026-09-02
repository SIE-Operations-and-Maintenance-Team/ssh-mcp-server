//! Admin HTTP：axum 同端口承载
//! - `/mcp`          → rmcp StreamableHTTP（由 mcp::serve 挂入）
//! - `/admin/`       → admin-web/dist 静态资源（include_dir 编译进 exe —— 单体交付的关键）
//! - `/admin/api/*`  → 与 Node 版路由/响应形状对齐，现有 React 页面零改动

use crate::audit;
use crate::config::{self};
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use include_dir::{include_dir, Dir};
use tauri::AppHandle;

static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../admin-web/dist");

type ApiResult = Result<Response, Response>;

fn ok_json(v: serde_json::Value) -> Response {
    axum::Json(v).into_response()
}

fn err400(code: &str, msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(serde_json::json!({ "ok": false, "code": code, "message": msg.into() })),
    )
        .into_response()
}

fn err404(code: &str, msg: impl Into<String>) -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({ "ok": false, "code": code, "message": msg.into() })),
    )
        .into_response()
}

/// Node 版语义：业务失败但 HTTP 200 + {ok:false,...}
fn biz_err(body: serde_json::Value) -> Response {
    (StatusCode::OK, axum::Json(body)).into_response()
}

use rmcp::transport::streamable_http_server::{session::local::LocalSessionManager, StreamableHttpService};

type McpSvc = StreamableHttpService<crate::mcp::handler::McpHandler, LocalSessionManager>;

/// AppHandle 全局持有（update apply / restart 需要；serve 初始化时写入）
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

async fn apply_update() -> ApiResult {
    match APP_HANDLE.get() {
        Some(h) => crate::updater::spawn_apply(h.clone()),
        None => eprintln!("[update] AppHandle 未初始化"),
    }
    Ok(ok_json(serde_json::json!({ "applying": true })))
}

pub fn build_router(app: AppHandle, mcp_service: McpSvc) -> Router {
    let _ = APP_HANDLE.set(app.clone());
    let app_status = app.clone();
    let app_check = app.clone();
    Router::new()
        .nest_service("/mcp", mcp_service)
        .route(
            "/admin/api/update/status",
            get(move || async move { ok_json(crate::updater::status(app_status).await) }),
        )
        .route(
            "/admin/api/update/check",
            post(move || async move { ok_json(crate::updater::check(app_check.clone()).await) }),
        )
        .route("/admin/api/update/apply", post(apply_update))
        .route("/", get(|| async { Redirect::temporary("/admin/") }))
        .route("/admin", get(|| async { Redirect::temporary("/admin/") }))
        .route("/admin/", get(index_html))
        .route("/admin/{*path}", get(static_file))
        // ── projects 树 ──
        .route("/admin/api/projects", get(projects_list).post(projects_save))
        .route(
            "/admin/api/projects/{project}",
            get(project_get).delete(project_delete),
        )
        .route(
            "/admin/api/projects/{project}/environments",
            post(env_save),
        )
        .route(
            "/admin/api/projects/{project}/environments/{env}",
            delete(env_delete),
        )
        .route(
            "/admin/api/projects/{project}/environments/{env}/hosts",
            post(host_save),
        )
        .route(
            "/admin/api/projects/{project}/environments/{env}/hosts/{host}",
            delete(host_delete),
        )
        .route("/admin/api/connections", get(connections_flat))
        // ── 安全 / 设置 / 系统 / 审计 / 备份 ──
        .route("/admin/api/security", get(security_get).post(security_post))
        .route("/admin/api/settings", get(settings_get).post(settings_post))
        .route("/admin/api/system/info", get(system_info))
        .route("/admin/api/defaults", get(defaults))
        .route("/admin/api/audit", get(audit_query))
        .route("/admin/api/backups", get(backups_list))
        .route("/admin/api/backups/snapshot", post(backups_snapshot))
        .route("/admin/api/backups/restore/{id}", post(backups_restore))
        .route("/admin/api/test-connection", post(test_connection))
        // ── 排序 / 导入导出 / 注册 MCP / 自启动 / 重启 ──
        .route("/admin/api/projects/reorder", post(projects_reorder))
        .route(
            "/admin/api/projects/{project}/environments/{env}/hosts/reorder",
            post(hosts_reorder),
        )
        .route("/admin/api/config/export", get(config_export))
        .route("/admin/api/config/import", post(config_import))
        .route(
            "/admin/api/connections",
            post(connections_legacy_save),
        )
        .route(
            "/admin/api/connections/{name}",
            delete(connections_legacy_delete),
        )
        .route("/admin/api/system/register-mcp", post(register_mcp))
        .route(
            "/admin/api/autostart",
            get(autostart_get).put(autostart_put),
        )
        .route("/admin/api/restart", post(restart))
        .with_state(())
}

// ── 静态资源（include_dir 内嵌）──

async fn index_html() -> Response {
    serve_asset("index.html").unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

async fn static_file(Path(path): Path<String>) -> Response {
    let p = path.strip_prefix("admin/").unwrap_or(&path);
    match serve_asset(p) {
        Some(resp) => resp,
        None => serve_asset("index.html") // SPA fallback
            .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response()),
    }
}

fn serve_asset(name: &str) -> Option<Response> {
    let file = FRONTEND_DIST.get_file(name)?;
    let mime = mime_of(name);
    Some(([(header::CONTENT_TYPE, mime)], file.contents()).into_response())
}

fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "map" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

// ── projects ──

async fn projects_list() -> ApiResult {
    let cfg = config::load();
    let list: Vec<serde_json::Value> = cfg
        .projects
        .iter()
        .map(|(name, proj)| {
            let env_count = proj.environments.len();
            let host_count: usize = proj.environments.values().map(|e| e.hosts.len()).sum();
            serde_json::json!({
                "name": name,
                "displayName": proj.display_name,
                "defaultEnvironment": proj.default_environment,
                "environmentCount": env_count,
                "hostCount": host_count,
            })
        })
        .collect();
    Ok(ok_json(serde_json::Value::Array(list)))
}

async fn project_get(Path(project): Path<String>) -> ApiResult {
    let cfg = config::load();
    let proj = cfg.projects.get(&project);
    match proj {
        Some(p) => Ok(ok_json(serde_json::to_value(p).unwrap_or_default())),
        None => Err(err404("PROJECT_NOT_FOUND", format!("项目不存在: {project}"))),
    }
}

/// body: { name, originalName?, displayName?, defaultEnvironment? }
async fn projects_save(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err400("INVALID_NAME", "项目名称不能为空"));
    }
    let original = body["originalName"].as_str().map(|s| s.trim().to_string());
    let mut cfg = config::load();
    if let Some(orig) = &original {
        if !cfg.projects.contains_key(orig) {
            return Err(err404("PROJECT_NOT_FOUND", format!("项目不存在: {orig}")));
        }
        if orig != &name && cfg.projects.contains_key(&name) {
            return Err(err400("HOST_EXISTS", format!("项目已存在: {name}")));
        }
        // 第一段：原地字段更新（借用即取即还）
        {
            let src = cfg.projects.get_mut(orig).unwrap();
            if let Some(dn) = body["displayName"].as_str() {
                src.display_name = Some(dn.to_string());
            }
            if let Some(de) = body["defaultEnvironment"].as_str() {
                src.default_environment = Some(de.to_string());
            }
            if !src.environments.is_empty()
                && src
                    .default_environment
                    .as_deref()
                    .is_none_or(|d| !src.environments.contains_key(d) && d != "测试环境")
            {
                // 默认环境缺失时回退测试环境（对齐 Node 行为）
                if src.environments.contains_key("测试环境") {
                    src.default_environment = Some("测试环境".into());
                }
            }
        }
        // 第二段：重命名（借用已释放）
        if orig != &name {
            if let Some(moved) = cfg.projects.remove(orig) {
                cfg.projects.insert(name.clone(), moved);
            }
            if let Some(pos) = cfg.project_order.iter().position(|x| x == orig) {
                cfg.project_order[pos] = name.clone();
            }
        }
    } else {
        if cfg.projects.contains_key(&name) {
            return Err(err400("HOST_EXISTS", format!("项目已存在: {name}")));
        }
        let mut proj = crate::config::ProjectConfig::default();
        for e in ["开发环境", "测试环境", "生产环境", "UAT环境"] {
            proj.environments.insert(e.to_string(), Default::default());
        }
        if let Some(dn) = body["displayName"].as_str() {
            proj.display_name = Some(dn.to_string());
        }
        proj.default_environment = Some(
            body["defaultEnvironment"]
                .as_str()
                .unwrap_or("测试环境")
                .to_string(),
        );
        if !proj.environments.contains_key(proj.default_environment.as_deref().unwrap_or("")) {
            let de = proj.default_environment.clone().unwrap();
            proj.environments.insert(de, Default::default());
        }
        cfg.projects.insert(name, proj);
    }
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

async fn project_delete(Path(project): Path<String>) -> ApiResult {
    let mut cfg = config::load();
    if cfg.projects.remove(&project).is_none() {
        return Err(err404("PROJECT_NOT_FOUND", format!("项目不存在: {project}")));
    }
    cfg.project_order.retain(|x| x != &project);
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

/// body: { name, originalName?, displayName? }
async fn env_save(Path(project): Path<String>, axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err400("INVALID_NAME", "环境名称不能为空"));
    }
    let original = body["originalName"].as_str().map(|s| s.trim().to_string());
    let mut cfg = config::load();
    let proj = cfg
        .projects
        .get_mut(&project)
        .ok_or_else(|| err404("PROJECT_NOT_FOUND", format!("项目不存在: {project}")))?;
    match original {
        Some(orig) => {
            let env = proj
                .environments
                .remove(&orig)
                .ok_or_else(|| err404("ENVIRONMENT_NOT_FOUND", format!("环境不存在: {orig}")))?;
            if let Some(dn) = body["displayName"].as_str() {
                let mut env = env;
                env.display_name = Some(dn.to_string());
                proj.environments.insert(name.clone(), env);
            } else {
                proj.environments.insert(name.clone(), env);
            }
            if proj.default_environment.as_deref() == Some(orig.as_str()) {
                proj.default_environment = Some(name.clone());
            }
        }
        None => {
            if proj.environments.contains_key(&name) {
                return Err(err400("HOST_EXISTS", format!("环境已存在: {name}")));
            }
            let mut env = crate::config::EnvironmentConfig::default();
            if let Some(dn) = body["displayName"].as_str() {
                env.display_name = Some(dn.to_string());
            }
            proj.environments.insert(name, env);
        }
    }
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

async fn env_delete(Path((project, env)): Path<(String, String)>) -> ApiResult {
    let mut cfg = config::load();
    let proj = cfg
        .projects
        .get_mut(&project)
        .ok_or_else(|| err404("PROJECT_NOT_FOUND", format!("项目不存在: {project}")))?;
    if proj.environments.remove(&env).is_none() {
        return Err(err404("ENVIRONMENT_NOT_FOUND", format!("环境不存在: {env}")));
    }
    if proj.default_environment.as_deref() == Some(env.as_str()) {
        proj.default_environment = None;
    }
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

/// body: HostConfig 全量（{ name, host, port, username, ... }）
async fn host_save(
    Path((project, env)): Path<(String, String)>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> ApiResult {
    let mut cfg = config::load();
    let conn = crate::config::HostConfig {
        name: body["name"].as_str().unwrap_or("").trim().to_string(),
        host: body["host"].as_str().unwrap_or("").trim().to_string(),
        port: body["port"].as_u64().unwrap_or(22) as u16,
        username: body["username"].as_str().unwrap_or("").to_string(),
        password: secret_from(&body, "password"),
        private_key: opt_str(&body, "privateKey"),
        passphrase: secret_from(&body, "passphrase"),
        agent: opt_str(&body, "agent"),
        try_keyboard: body["tryKeyboard"].as_bool(),
        proxy: opt_str(&body, "proxy"),
        socks_proxy: opt_str(&body, "socksProxy"),
        pty: body["pty"].as_bool(),
        transport_mode: opt_str(&body, "transportMode"),
        shell_ready_timeout_ms: num_u64(&body, "shellReadyTimeoutMs"),
        shell_command_timeout_ms: num_u64(&body, "shellCommandTimeoutMs"),
        command_timeout_ms: num_u64(&body, "commandTimeoutMs"),
        connection_timeout_ms: num_u64(&body, "connectionTimeoutMs"),
        sftp_timeout_ms: num_u64(&body, "sftpTimeoutMs"),
        max_output_bytes: num_u64(&body, "maxOutputBytes"),
        keepalive_interval_ms: num_u32(&body, "keepaliveIntervalMs"),
        keepalive_count_max: num_u32(&body, "keepaliveCountMax"),
        command_template: opt_str(&body, "commandTemplate"),
        command_whitelist: str_arr(&body, "commandWhitelist"),
        command_blacklist: str_arr(&body, "commandBlacklist"),
        allowed_local_paths: str_arr(&body, "allowedLocalPaths"),
        allowed_remote_paths: str_arr(&body, "allowedRemotePaths"),
    };
    if conn.name.is_empty() || conn.host.is_empty() || conn.username.is_empty() {
        return Err(err400("INVALID_ADDRESS", "主机地址格式不正确或缺少必填字段"));
    }

    // 密码保留语义：前端回传 "***" 时沿用旧值（对齐 Node maskHost 行为）
    let original = body["originalName"].as_str().map(|s| s.trim().to_string());
    let target_env = cfg
        .projects
        .get_mut(&project)
        .and_then(|p| p.environments.get_mut(&env))
        .ok_or_else(|| err404("PROJECT_NOT_FOUND", format!("项目/环境不存在: {project}/{env}")))?;

    let lookup = original.clone().or_else(|| Some(conn.name.clone()));
    let existing_secret = lookup
        .as_ref()
        .and_then(|k| target_env.hosts.get(k))
        .cloned();

    let mut conn = conn;
    if existing_secret.is_some() {
        let old = existing_secret.unwrap();
        if conn.password.is_none() {
            conn.password = old.password.clone();
        }
        if conn.passphrase.is_none() {
            conn.passphrase = old.passphrase.clone();
        }
    }
    let key = conn.name.clone();
    if target_env.hosts.contains_key(&key)
        && original.as_deref().is_none_or(|o| o != key)
    {
        return Err(err400("HOST_EXISTS", format!("主机已存在: {key}")));
    }
    target_env.hosts.insert(key.clone(), conn);
    if let Some(o) = original {
        if o != key {
            target_env.hosts.remove(&o);
        }
    }
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

async fn host_delete(
    Path((project, env, host)): Path<(String, String, String)>,
) -> ApiResult {
    let mut cfg = config::load();
    let removed = cfg
        .projects
        .get_mut(&project)
        .and_then(|p| p.environments.get_mut(&env))
        .and_then(|e| e.hosts.remove(&host));
    if removed.is_none() {
        return Err(err404("HOST_NOT_FOUND", format!("主机不存在: {host}")));
    }
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

async fn connections_flat() -> ApiResult {
    let cfg = config::load();
    let flat = cfg.flatten_hosts();
    let map: serde_json::Map<String, serde_json::Value> = flat
        .iter()
        .map(|(k, (_, _, _, c))| (k.clone(), serde_json::to_value(c).unwrap_or_default()))
        .collect();
    Ok(ok_json(serde_json::Value::Object(map)))
}

// ── security / settings / system / defaults ──

async fn security_get() -> ApiResult {
    let cfg = config::load();
    Ok(ok_json(serde_json::to_value(cfg.security.unwrap_or_default()).unwrap_or_default()))
}

async fn security_post(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let parse_list =
        |v: &serde_json::Value| -> Result<Option<Vec<String>>, String> {
            match v {
                serde_json::Value::Null => Ok(None),
                serde_json::Value::String(s) => Ok(Some(
                    s.split('\n')
                        .map(|x| normalize_pattern(x.trim()))
                        .filter(|x| !x.is_empty())
                        .collect(),
                )),
                serde_json::Value::Array(a) => Ok(Some(
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(|x| normalize_pattern(x.trim()))
                        .filter(|x| !x.is_empty())
                        .collect(),
                )),
                _ => Err("格式不正确".into()),
            }
        };
    let wl = parse_list(&body["commandWhitelist"]).map_err(|e| err400("INVALID_SECURITY", e))?;
    let bl = parse_list(&body["commandBlacklist"]).map_err(|e| err400("INVALID_SECURITY", e))?;
    let paths = |v: &serde_json::Value| -> Vec<String> {
        match v {
            serde_json::Value::String(s) => s
                .split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|x| x.as_str().map(|y| y.trim().to_string()))
                .filter(|x| !x.is_empty())
                .collect(),
            _ => vec![],
        }
    };
    let mut cfg = config::load();
    cfg.security = Some(crate::config::SecurityConfig {
        command_whitelist: wl,
        command_blacklist: bl,
        allowed_local_paths: Some(paths(&body["allowedLocalPaths"])),
        allowed_remote_paths: Some(paths(&body["allowedRemotePaths"])),
    });
    config::save(&cfg).map_err(|e| err400("INVALID_SECURITY", e))?;
    let sec = cfg.security.clone();
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true, "security": sec })))
}

fn normalize_pattern(s: &str) -> String {
    if s.is_empty() {
        return s.to_string();
    }
    if s.starts_with('^') {
        s.to_string()
    } else {
        format!("^{s}")
    }
}

async fn settings_get() -> ApiResult {
    let cfg = config::load();
    Ok(ok_json(serde_json::json!({
        "port": cfg.admin_port(),
        "preConnect": cfg.pre_connect.unwrap_or(false),
        "audit": cfg.audit.clone().unwrap_or_default(),
        "backups": cfg.backups.clone().unwrap_or_default(),
    })))
}

async fn settings_post(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let mut cfg = config::load();
    if let Some(p) = body["port"].as_u64() {
        if !(1..=65535).contains(&p) {
            return Err(err400("INVALID_PORT", "port out of range"));
        }
        cfg.port = Some(p as u16);
    }
    if let Some(b) = body["preConnect"].as_bool() {
        cfg.pre_connect = Some(b);
    }
    if let Some(a) = body.get("audit") {
        cfg.audit = Some(crate::config::AuditSettings {
            enabled: a["enabled"].as_bool().or(cfg.audit.clone().and_then(|x| x.enabled)),
            retention_days: num_u32(a, "retentionDays")
                .or(cfg.audit.clone().and_then(|x| x.retention_days)),
            log_results: a["logResults"]
                .as_bool()
                .or(cfg.audit.clone().and_then(|x| x.log_results)),
        });
    }
    if let Some(b) = body.get("backups") {
        cfg.backups = Some(crate::config::BackupSettings {
            retention_days: num_u32(b, "retentionDays")
                .or(cfg.backups.clone().and_then(|x| x.retention_days)),
            max_count: b["maxCount"].as_u64().map(|v| v as u32),
            auto_enabled: Some(
                b["autoEnabled"]
                    .as_bool()
                    .or(cfg.backups.clone().and_then(|x| x.auto_enabled))
                    .unwrap_or(false),
            ),
            interval_hours: num_u32(b, "intervalHours")
                .or(cfg.backups.clone().and_then(|x| x.interval_hours)),
        });
    }
    config::save(&cfg).map_err(|e| err400("INVALID_SETTINGS", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

async fn system_info() -> ApiResult {
    let addr_port = admin_http_port();
    Ok(ok_json(serde_json::json!({
        "port": addr_port,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform_str(),
        "configPath": config::config_path().display().to_string(),
    })))
}

fn admin_http_port() -> u16 {
    crate::mcp::manager::bound_port().unwrap_or(crate::config::DEFAULT_ADMIN_PORT)
}

async fn defaults() -> ApiResult {
    Ok(ok_json(serde_json::json!({
        "defaultEnvironments": ["开发环境", "测试环境", "生产环境", "UAT环境"],
        "defaultCommandBlacklist": [
            "^rm\\s+.*", "^shutdown.*", "^reboot.*", "^halt.*", "^poweroff.*", "^mkfs.*", "^dd\\s+.*"
        ],
    })))
}

// ── audit ──

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditQueryParams {
    page: Option<usize>,
    page_size: Option<usize>,
    q: Option<String>,
    connection: Option<String>,
    tool: Option<String>,
    status: Option<String>,
}

async fn audit_query(Query(q): Query<AuditQueryParams>) -> ApiResult {
    Ok(ok_json(audit::query(
        q.page.unwrap_or(1),
        q.page_size.unwrap_or(20),
        q.q.as_deref(),
        q.connection.as_deref(),
        q.tool.as_deref(),
        q.status.as_deref(),
    )))
}

// ── backups ──

fn backups_dir() -> std::path::PathBuf {
    crate::backup::backups_dir()
}

async fn backups_list() -> ApiResult {
    // 时间以文件名内嵌时间戳为准（Windows 复制保留源 mtime，mtime 不可信）
    let items: Vec<serde_json::Value> = crate::backup::list_files()
        .into_iter()
        .map(|(p, ts)| {
            serde_json::json!({
                "id": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                "name": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                "path": p.display().to_string(),
                "ts": ts,
            })
        })
        .collect();
    Ok(ok_json(serde_json::Value::Array(items)))
}

async fn backups_snapshot() -> ApiResult {
    let name = crate::backup::do_snapshot().map_err(|e| err400("BACKUP_FAILED", e))?;
    let path = crate::backup::backups_dir().join(&name);
    Ok(ok_json(serde_json::json!({
        "id": name,
        "name": name,
        "path": path.display().to_string(),
        "ts": crate::backup::now_ms(),
    })))
}

async fn backups_restore(Path(id): Path<String>) -> ApiResult {
    // 恢复前先快照当前（对齐 Node BackupService.restore）
    let _ = do_snapshot_internal()?;
    let src = backups_dir().join(&id);
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(err400("RESTORE_FAILED", "非法备份 ID"));
    }
    if !src.exists() {
        return Err(err404("BACKUP_NOT_FOUND", format!("备份不存在: {id}")));
    }
    std::fs::copy(&src, config::config_path()).map_err(|e| err400("RESTORE_FAILED", e.to_string()))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

fn do_snapshot_internal() -> Result<(), Response> {
    crate::backup::do_snapshot().map_err(|e| err400("BACKUP_FAILED", e))?;
    Ok(())
}

// ── 排序 / 导入导出 / 注册 MCP / 自启动 / 重启 ──

/// body: { order: string[] } → projectOrder 持久化
async fn projects_reorder(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let Some(order) = body["order"].as_array() else {
        return Err(err400("INVALID_ORDER", "order 必须是数组"));
    };
    let mut cfg = config::load();
    let mut seen: Vec<String> = Vec::new();
    for name in order {
        if let Some(n) = name.as_str() {
            if cfg.projects.contains_key(n) && !seen.iter().any(|x| x == n) {
                seen.push(n.to_string());
            }
        }
    }
    for name in cfg.projects.keys() {
        if !seen.contains(name) {
            seen.push(name.clone());
        }
    }
    cfg.project_order = seen;
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

/// body: { order: string[] } → 环境 hostOrder 持久化
async fn hosts_reorder(
    Path((project, env)): Path<(String, String)>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> ApiResult {
    let Some(order) = body["order"].as_array() else {
        return Err(err400("INVALID_ORDER", "order 必须是数组"));
    };
    let mut cfg = config::load();
    let target = cfg
        .projects
        .get_mut(&project)
        .and_then(|p| p.environments.get_mut(&env))
        .ok_or_else(|| err404("PROJECT_NOT_FOUND", format!("项目/环境不存在: {project}/{env}")))?;
    let mut seen: Vec<String> = Vec::new();
    for name in order {
        if let Some(n) = name.as_str() {
            if target.hosts.contains_key(n) && !seen.iter().any(|x| x == n) {
                seen.push(n.to_string());
            }
        }
    }
    for name in target.hosts.keys() {
        if !seen.contains(name) {
            seen.push(name.clone());
        }
    }
    target.host_order = seen;
    config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

/// 完整配置导出：projects 原样 + legacy connections 扁平视图（对齐 Node export）
async fn config_export() -> ApiResult {
    let cfg = config::load();
    let flat = cfg.flatten_hosts();
    let connections: serde_json::Map<String, serde_json::Value> = flat
        .iter()
        .map(|(k, (_, _, _, c))| (k.clone(), serde_json::to_value(c).unwrap_or_default()))
        .collect();
    Ok(ok_json(serde_json::json!({
        "projects": cfg.projects,
        "projectOrder": cfg.project_order,
        "connections": connections,
        "port": cfg.port,
        "audit": cfg.audit,
        "backups": cfg.backups,
        "security": cfg.security,
        "preConnect": cfg.pre_connect,
    })))
}

/// 导入合并：projects 全量并入（同项目/环境/主机覆盖），legacy connections 归 default/default
async fn config_import(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let mut cfg = config::load();
    let mut added_projects = 0u32;
    let mut updated_projects = 0u32;
    let mut added_environments = 0u32;
    let mut added_hosts = 0u32;
    let mut warnings: Vec<String> = Vec::new();

    let projects_in = body.get("projects").and_then(|p| p.as_object());

    match projects_in {
        Some(map) if !map.is_empty() => {
            if body.get("connections").is_some() {
                warnings.push("检测到旧格式 connections，已忽略以 projects 为准".into());
            }
            for (p_name, p_val) in map {
                // 解析失败记 warning 跳过（对齐 Node 版逐项 try/catch），不再静默清空整项目
                let mut proj = match serde_json::from_value::<crate::config::ProjectConfig>(
                    p_val.clone(),
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        warnings.push(format!("跳过非法项目 {p_name}: {e}"));
                        continue;
                    }
                };
                // 主机名回填：hosts map 的 key 是唯一标识，源数据对象内 name 缺失时
                // 用 key 补齐（对齐 Node 版 normalize.name = hName）；key 空白的跳过并告警
                let mut skipped_hosts = 0u32;
                for env in proj.environments.values_mut() {
                    for (h_name, mut hc) in std::mem::take(&mut env.hosts) {
                        if h_name.trim().is_empty() {
                            skipped_hosts += 1;
                            continue;
                        }
                        if hc.name.trim().is_empty() {
                            hc.name = h_name.clone();
                        }
                        env.hosts.insert(h_name, hc);
                    }
                }
                if skipped_hosts > 0 {
                    warnings.push(format!("项目 {p_name} 跳过空白主机名 {skipped_hosts} 个"));
                }
                match cfg.projects.remove(p_name) {
                    None => {
                        added_projects += 1;
                        let hosts_added: u32 =
                            proj.environments.values().map(|e| e.hosts.len() as u32).sum();
                        added_environments += proj.environments.len() as u32;
                        added_hosts += hosts_added;
                        cfg.projects.insert(p_name.clone(), proj);
                    }
                    Some(old) => {
                        updated_projects += 1;
                        let mut merged = old;
                        merged.display_name =
                            proj.display_name.or(merged.display_name);
                        merged.default_environment = proj
                            .default_environment
                            .or(merged.default_environment);
                        for (e_name, env_in) in proj.environments {
                            match merged.environments.remove(&e_name) {
                                None => {
                                    added_environments += 1;
                                    added_hosts += env_in.hosts.len() as u32;
                                    merged.environments.insert(e_name, env_in);
                                }
                                Some(mut old_env) => {
                                    for (h_name, hc) in env_in.hosts {
                                        if !old_env.hosts.insert(h_name, hc).is_none() {
                                            // 已存在则覆盖，不计数新增
                                        } else {
                                            added_hosts += 1;
                                        }
                                    }
                                    merged.environments.insert(e_name, old_env);
                                }
                            }
                        }
                        cfg.projects.insert(p_name.clone(), merged);
                    }
                }
            }
        }
        _ => {
            // legacy：connections（数组或对象）或 body 本身就是 connections
            let raw = body
                .get("connections")
                .cloned()
                .unwrap_or_else(|| body.clone());
            let looks_like_connections = raw.is_array()
                || raw
                    .as_object()
                    .map(|o| {
                        o.values().any(|v| v.get("host").is_some()) || o.contains_key("host")
                    })
                    .unwrap_or(false);
            if !looks_like_connections {
                return Err(err400(
                    "INVALID_IMPORT",
                    "导入数据为空或格式不正确",
                ));
            }
            warnings.push("检测到旧格式 connections，已自动归入 default/default".into());
            if !cfg.projects.contains_key("default") {
                cfg.projects.insert("default".into(), Default::default());
                added_projects += 1;
            }
            let proj = cfg.projects.get_mut("default").unwrap();
            if proj.display_name.is_none() {
                proj.display_name = Some("默认项目".into());
            }
            if !proj.environments.contains_key("default") {
                proj.environments.insert("default".into(), Default::default());
                added_environments += 1;
            }
            let env = proj.environments.get_mut("default").unwrap();
            if env.display_name.is_none() {
                env.display_name = Some("默认环境".into());
            }
            let pairs: Vec<(String, serde_json::Value)> = match &raw {
                serde_json::Value::Array(a) => a
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        (
                            v.get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or(&format!("host-{i}"))
                                .to_string(),
                            v.clone(),
                        )
                    })
                    .collect(),
                serde_json::Value::Object(o) => o
                    .iter()
                    .map(|(k, v)| {
                        (
                            v.get("name")
                                .and_then(|n| n.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| k.clone()),
                            v.clone(),
                        )
                    })
                    .collect(),
                _ => vec![],
            };
            for (h_name, h_val) in pairs {
                if h_name.trim().is_empty() {
                    warnings.push(format!("跳过非法主机名: {h_name}"));
                    continue;
                }
                match serde_json::from_value::<crate::config::HostConfig>(h_val.clone()) {
                    Ok(mut hc) => {
                        hc.name = h_name.clone();
                        if env.hosts.insert(h_name.clone(), hc).is_none() {
                            added_hosts += 1;
                        }
                    }
                    Err(e) => warnings.push(format!("跳过非法主机 {h_name}: {e}")),
                }
            }
        }
    }

    config::save(&cfg).map_err(|e| err400("INVALID_IMPORT", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({
        "ok": true,
        "addedProjects": added_projects,
        "updatedProjects": updated_projects,
        "addedEnvironments": added_environments,
        "addedHosts": added_hosts,
        "warnings": warnings,
        "count": added_hosts,
    })))
}

/// legacy POST /admin/api/connections：写入 default/default
async fn connections_legacy_save(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let mut cfg = config::load();
    if !cfg.projects.contains_key("default") {
        cfg.projects.insert("default".into(), Default::default());
    }
    let proj = cfg.projects.get_mut("default").unwrap();
    if !proj.environments.contains_key("default") {
        proj.environments.insert("default".into(), Default::default());
    }
    let env = proj.environments.get_mut("default").unwrap();

    let host_cfg: crate::config::HostConfig = serde_json::from_value(body)
        .map_err(|e| err400("INVALID_CONNECTION", e.to_string()))?;
    let name = if host_cfg.name.trim().is_empty() {
        return Err(err400("INVALID_CONNECTION", "缺少 name 字段"));
    } else {
        host_cfg.name.clone()
    };
    let existing = env.hosts.get(&name);
    let mut host_cfg = host_cfg;
    if let Some(old) = existing {
        // 密码保留语义（前端掩码回传）
        if host_cfg.password.is_none() && old.password.is_some() {
            host_cfg.password = old.password.clone();
        }
        if host_cfg.passphrase.is_none() && old.passphrase.is_some() {
            host_cfg.passphrase = old.passphrase.clone();
        }
    }
    env.hosts.insert(name, host_cfg);
    config::save(&cfg).map_err(|e| err400("INVALID_CONNECTION", e))?;
    notify_cfg_changed();
    Ok(ok_json(serde_json::json!({ "ok": true })))
}

/// legacy DELETE /admin/api/connections/:name —— 支持 p/e/h 全路径或全局唯一简写
async fn connections_legacy_delete(Path(name): Path<String>) -> ApiResult {
    let mut cfg = config::load();
    let flat = cfg.flatten_hosts();
    let target: Option<String> = if flat.contains_key(&name) {
        Some(name.clone())
    } else {
        // 简写：按主机名唯一匹配
        let matches: Vec<String> = flat
            .iter()
            .filter(|(_, (_, _, h, _))| *h == name)
            .map(|(k, _)| k.clone())
            .collect();
        if matches.len() == 1 {
            Some(matches.into_iter().next().unwrap())
        } else {
            None
        }
    };
    if let Some(key) = target {
        let parts: Vec<&str> = key.split('/').collect();
        if parts.len() == 3 {
            if let Some(proj) = cfg.projects.get_mut(parts[0]) {
                if let Some(env) = proj.environments.get_mut(parts[1]) {
                    if env.hosts.remove(parts[2]).is_some() {
                        config::save(&cfg).map_err(|e| err400("VALIDATION_ERROR", e))?;
                        notify_cfg_changed();
                        return Ok(ok_json(serde_json::json!({ "ok": true })));
                    }
                }
            }
        }
    }
    Err(err404("HOST_NOT_FOUND", format!("主机不存在: {name}")))
}

/// 一键注册 MCP 到指定客户端 mcp.json（照 Node system.ts 语义）
async fn register_mcp(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let client = body["client"].as_str().unwrap_or("claude").to_string();
    let scope = body["scope"].as_str().unwrap_or("user").to_string();
    let server_name = body["serverName"]
        .as_str()
        .unwrap_or("ssh-mcp-server")
        .to_string();
    let port = body["port"].as_u64().map(|v| v as u16);
    let force = body["force"].as_bool().unwrap_or(false);

    // client/serverName 拼进文件名，限定字符集防路径穿越（对齐 Node）
    let safe = |s: &str| !s.is_empty() && s.len() <= 32
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !safe(&client) || !safe(&server_name) {
        return Err(err400(
            "INVALID_CLIENT",
            "client/serverName 仅允许字母、数字、_、-（1-32 字符）",
        ));
    }

    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_else(|_| ".".into());
    let target: std::path::PathBuf = match client.as_str() {
        "claude" => {
            if scope == "project" {
                std::env::current_dir().unwrap_or_default().join(".claude.json")
            } else {
                std::path::Path::new(&home).join(".claude.json")
            }
        }
        "vscode" => std::path::Path::new(&home).join(".vscode").join("mcp.json"),
        other => std::path::Path::new(&home)
            .join(format!(".{other}-mcp.json")),
    };

    // mcp 端口：请求未指定时用当前服务端口
    let actual_port = port.unwrap_or_else(|| {
        crate::mcp::manager::bound_port().unwrap_or(crate::config::DEFAULT_ADMIN_PORT)
    });
    let entry = serde_json::json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{actual_port}/mcp"),
    });

    // 读现有 JSON，判断冲突 / 合并写入（保留其余字段）
    let mut root: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&target) {
        serde_json::from_str(&raw)
            .map_err(|e| err400("PARSE_ERROR", format!("target json parse failed: {e}")))?
    } else {
        serde_json::json!({})
    };
    let use_servers_key = root.get("mcpServers").is_none() && root.get("servers").is_some();
    let servers_key = if use_servers_key { "servers" } else { "mcpServers" };
    if root.get(servers_key).and_then(|s| s.get(&server_name)).is_some() && !force {
        return Ok(ok_json(serde_json::json!({
            "ok": true, "conflict": true, "path": target.display().to_string(),
        })));
    }
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    obj.insert(servers_key.to_string(), serde_json::json!({}));
    obj.get_mut(servers_key).unwrap().as_object_mut().unwrap()
        .insert(server_name.clone(), entry);
    // 双键兼容：旧客户端读 servers，新客户端读 mcpServers（对齐 Node 行为同步两键）
    if servers_key == "mcpServers" {
        obj.insert("servers".into(), obj["mcpServers"].clone());
    } else {
        obj.insert("mcpServers".into(), obj["servers"].clone());
    }

    std::fs::create_dir_all(target.parent().unwrap())
        .map_err(|e| err400("WRITE_FAILED", e.to_string()))?;
    std::fs::write(
        &target,
        serde_json::to_string_pretty(&root).unwrap_or_default(),
    )
    .map_err(|e| err400("WRITE_FAILED", e.to_string()))?;
    Ok(ok_json(serde_json::json!({
        "ok": true, "conflict": false, "path": target.display().to_string(),
    })))
}

// ── 自启动（HKCU Run）──

fn run_key_path() -> &'static str {
    r"Software\Microsoft\Windows\CurrentVersion\Run"
}

fn autostart_value_name() -> &'static str {
    "SshMcpServer"
}

async fn autostart_get() -> ApiResult {
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let enabled = hkcu
            .open_subkey(run_key_path())
            .ok()
            .and_then(|k| k.get_value::<String, _>(autostart_value_name()).ok())
            .is_some();
        return Ok(ok_json(serde_json::json!({ "enabled": enabled, "supported": true })));
    }
    #[cfg(not(windows))]
    {
        Ok(ok_json(serde_json::json!({ "enabled": false, "supported": false })))
    }
}

async fn autostart_put(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let enabled = body["enabled"].as_bool().unwrap_or(false);
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let display = format!("\"{}\" --autostart", exe.display());
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(run_key_path(), winreg::enums::KEY_SET_VALUE)
            .map_err(|e| err400("AUTOSTART_FAILED", e.to_string()))?;
        let write_result = if enabled {
            key.set_value(autostart_value_name(), &display)
        } else {
            // 幂等删除：目标不存在也视为成功
            match key.delete_value(autostart_value_name()) {
                Ok(_) => Ok(()),
                Err(_) => Ok(()),
            }
        };
        write_result.map_err(|e| err400("AUTOSTART_FAILED", e.to_string()))?;
        let now_enabled = hkcu
            .open_subkey(run_key_path())
            .ok()
            .and_then(|k| k.get_value::<String, _>(autostart_value_name()).ok())
            .is_some();
        Ok(ok_json(serde_json::json!({ "ok": true, "enabled": now_enabled, "supported": true })))
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err(err400("UNSUPPORTED_PLATFORM", "登录自启动仅支持 Windows"))
    }
}

/// 软重启：延迟拉起自身后退出（避开 single-instance 竞态）
async fn restart() -> ApiResult {
    // Tauri 内置 relaunch：退出当前进程并以最新安装版本重启
    if let Some(h) = APP_HANDLE.get() {
        let h = h.clone();
        tauri::async_runtime::spawn(async move {
            std::process::exit(0);
        });
        h.restart();
    }
    std::process::exit(0);
}

async fn test_connection(axum::Json(body): axum::Json<serde_json::Value>) -> ApiResult {
    let host = body["host"].as_str().unwrap_or("");
    let port = body["port"].as_u64().unwrap_or(22) as u16;
    let username = body["username"].as_str().unwrap_or("");
    let password = body["password"].as_str().unwrap_or("");
    if host.is_empty() || username.is_empty() {
        return Err(err400("CONNECT_FAILED", "host/username 必填"));
    }
    let start = std::time::Instant::now();
    let addr = format!("{host}:{port}");
    use std::net::ToSocketAddrs;
    let username = username.to_string();
    let password = password.to_string();
    let res = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let sa = addr
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or("地址解析失败")?;
        let tcp = std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_secs(7))
            .map_err(|e| e.to_string())?;
        let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
        sess.set_tcp_stream(tcp);
        sess.handshake().map_err(|e| e.to_string())?;
        sess.userauth_password(&username, &password)
            .map_err(|e| format!("认证失败: {e}"))?;
        Ok(sess.authenticated())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));

    match res {
        Ok(true) => Ok(ok_json(
            serde_json::json!({ "ok": true, "latencyMs": start.elapsed().as_millis() }),
        )),
        Ok(false) => Err(biz_err(serde_json::json!(
            { "ok": false, "code": "CONNECT_FAILED", "message": "认证失败", "retriable": true }
        ))),
        Err(e) => Err(biz_err(serde_json::json!(
            { "ok": false, "code": "TIMEOUT", "message": e, "retriable": true }
        ))),
    }
}

// ── helpers ──

fn notify_cfg_changed() {
    crate::mcp::manager::notify_external_change();
}

fn opt_str(v: &serde_json::Value, k: &str) -> Option<String> {
    v[k].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn secret_from(v: &serde_json::Value, k: &str) -> Option<String> {
    match v[k].as_str() {
        Some("***") | Some("") | None => None,
        Some(s) => Some(s.to_string()),
    }
}

fn num_u64(v: &serde_json::Value, k: &str) -> Option<u64> {
    v[k].as_u64()
}

fn num_u32(v: &serde_json::Value, k: &str) -> Option<u32> {
    v[k].as_u64().map(|n| n as u32)
}

fn str_arr(v: &serde_json::Value, k: &str) -> Option<Vec<String>> {
    match &v[k] {
        serde_json::Value::Null => None,
        serde_json::Value::Array(a) => Some(
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect(),
        ),
        serde_json::Value::String(_) => None,
        _ => None,
    }
}

fn platform_str() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
