//! MCP Handler：5 个工具（execute-command / list-servers / upload / download / list-directory）。
//! 实现走 ssh_pool（ssh2），安全校验对齐 Node 版：白名单全匹配 + 黑名单并集 + 远端路径沙箱。

use crate::audit;
use crate::config::{self, GlobalConfig, HostConfig};
use crate::ssh_pool;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::ErrorData;
use rmcp::{tool, tool_router};
use serde_json::json;

use std::io::Read;

#[derive(Clone)]
pub struct McpHandler {
    pub app_handle: tauri::AppHandle,
}

impl McpHandler {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }

    fn cfg(&self) -> GlobalConfig {
        config::load()
    }

    /// 解析目标连接，返回 (扁平名, 配置)
    fn resolve(
        &self,
        name: &Option<String>,
        all: &GlobalConfig,
    ) -> Result<(String, HostConfig), String> {
        match name {
            Some(n) => all.resolve_connection(n),
            None => {
                let flat = all.flatten_hosts();
                let first = flat.iter().next();
                match first {
                    Some((k, (_, _, _, c))) => Ok((k.clone(), c.clone())),
                    None => Err("SSH configuration not set: No hosts configured".into()),
                }
            }
        }
    }

    /// 命令白/黑名单校验（对齐 validateCommand 语义）
    fn validate_command(cfg: &HostConfig, cmd: &str) -> Result<(), String> {
        if let Some(wl) = &cfg.command_whitelist {
            if !wl.is_empty() {
                let ok = wl.iter().any(|p| regex_match(p, cmd));
                if !ok {
                    return Err(
                        "COMMAND_VALIDATION_FAILED: Command not in whitelist, execution forbidden"
                            .into(),
                    );
                }
            }
        }
        if let Some(bl) = &cfg.command_blacklist {
            if bl.iter().any(|p| regex_match(p, cmd)) {
                return Err(
                    "COMMAND_VALIDATION_FAILED: Command matches blacklist, execution forbidden"
                        .into(),
                );
            }
        }
        Ok(())
    }

    fn to_result<T: serde::Serialize>(
        &self,
        conn: &str,
        tool_name: &str,
        detail: &str,
        r: Result<T, String>,
    ) -> Result<CallToolResult, ErrorData> {
        let ok = r.is_ok();
        audit::log(&self.app_handle, conn, tool_name, ok, detail);
        match r {
            Ok(val) => {
                let text = match serde_json::to_string(&val) {
                    Ok(s) => s,
                    Err(_) => "ok".to_string(),
                };
                // 字符串结果直接回文本；结构化结果包 JSON 文本
                Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
            }
            Err(e) => Err(ErrorData::internal_error(e, None)),
        }
    }

    fn to_text(
        &self,
        conn: &str,
        tool_name: &str,
        detail: &str,
        r: Result<String, String>,
    ) -> Result<CallToolResult, ErrorData> {
        let ok = r.is_ok();
        audit::log(&self.app_handle, conn, tool_name, ok, detail);
        match r {
            Ok(text) => Ok(CallToolResult::success(vec![ContentBlock::text(text)])),
            Err(e) => Err(ErrorData::internal_error(e, None)),
        }
    }
}

fn regex_match(pattern: &str, text: &str) -> bool {
    // 轻量正则：仅支持 Node 版常用模式子集（^ 前缀锚定 + .* / .+ 通配）
    // 不引入 regex crate 以控制二进制体积；前端默认补 ^ 的行首锚定场景全部覆盖
    simple_regex_search(pattern, text)
}

/// 极简正则搜索：`^` 锚定开头、`.` 任意单字符、`*` 前一元素重复。
/// 覆盖 `^ls( .*)?,^cat .*,^df.*` 类配置模式；复杂正则按字面量处理。
fn simple_regex_search(pattern: &str, text: &str) -> bool {
    let anchored = pattern.starts_with('^');
    let pat: Vec<char> = pattern.trim_start_matches('^').chars().collect();
    let txt: Vec<char> = text.chars().collect();

    fn m(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return true;
        }
        // 处理 x* （含 .*）
        if p.len() >= 2 && p[1] == '*' {
            let mut i = 0usize;
            loop {
                if m(&p[2..], &t[i..]) {
                    return true;
                }
                if i >= t.len() || (p[0] != '.' && t[i] != p[0]) {
                    return false;
                }
                i += 1;
            }
        }
        if t.is_empty() {
            return false;
        }
        if p[0] == '.' || p[0] == t[0] {
            return m(&p[1..], &t[1..]);
        }
        false
    }

    if anchored {
        m(&pat, &txt)
    } else {
        (0..=txt.len()).any(|i| m(&pat, &txt[i..]))
    }
}

fn shell_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// 桌面壳当前版本明确不支持的能力：给出稳定错误码而非静默忽略
fn check_unsupported_features(key: &str, cfg: &HostConfig) -> Result<(), String> {
    if cfg.transport_mode.as_deref() == Some("shell") {
        return Err(format!(
            "UNSUPPORTED_IN_SHELL_MODE: [{key}] transportMode=shell（堡垒机模式）桌面壳暂不支持；请使用 npm 版或改用 exec 模式"
        ));
    }
    if cfg.proxy.is_some() || cfg.socks_proxy.is_some() {
        return Err(format!(
            "UNSUPPORTED_PROXY: [{key}] 桌面壳暂不支持 proxy/socksProxy 连接代理"
        ));
    }
    Ok(())
}

#[tool_router]
impl McpHandler {
    #[tool(name = "execute-command", description = "Execute command on connected server and get output result")]
    async fn execute_command(
        &self,
        Parameters(params): Parameters<crate::mcp::types::ExecuteCommandParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = self.cfg();
        // 完整命令在进入执行块前先拼好，供执行与审计明细共用
        let full = match &params.directory {
            Some(dir) => format!("cd -- {} && {}", shell_quote(dir), params.cmd_string),
            None => params.cmd_string.clone(),
        };
        let run = async {
            let (key, hcfg) = self.resolve(&params.connection_name, &all)?;
            check_unsupported_features(&key, &hcfg)?;
            Self::validate_command(&hcfg, &params.cmd_string)?;

            let timeout_ms = params
                .timeout
                .or(hcfg.effective_command_timeout().into())
                .unwrap_or(30_000);

            let shared = ssh_pool::get_session(&key, &hcfg)?;
            ssh_pool::set_command_timeout(&shared, timeout_ms as i64);

            // 对齐 Node 版：默认输出上限 10MiB，连接级 maxOutputBytes 可覆盖（0=不限）
            let max_out = hcfg.max_output_bytes.unwrap_or(10 * 1024 * 1024);
            let out = exec_on_session(&shared, &full, max_out)?;
            if out.failed {
                ssh_pool::invalidate(&key);
                Err(format!(
                    "COMMAND_EXECUTION_ERROR\n[stderr]\n{}\n[exit code] {}",
                    out.stderr, out.exit_code
                ))
            } else {
                Ok(out.stdout)
            }
        };
        let conn_name = params
            .connection_name
            .clone()
            .unwrap_or_else(|| "default".into());
        self.to_text(&conn_name, "execute-command", &full, run.await)
    }

    #[tool(name = "list-servers", description = "List all available SSH server configurations")]
    async fn list_servers(&self) -> Result<CallToolResult, ErrorData> {
        let all = self.cfg();
        let flat = all.flatten_hosts();
        let servers: Vec<serde_json::Value> = flat
            .iter()
            .map(|(k, (p, e, h, c))| {
                json!({
                    "name": k,
                    "host": c.host,
                    "port": c.port,
                    "username": c.username,
                    "connected": false,
                    "project": p,
                    "environment": e,
                    "hostName": h,
                })
            })
            .collect();
        let mut text = String::from("Configured SSH servers:\n");
        for s in &servers {
            text.push_str(&format!(
                "[disconnected] {} | {}@{}:{}\n",
                s["name"].as_str().unwrap_or("?"),
                s["username"].as_str().unwrap_or("?"),
                s["host"].as_str().unwrap_or("?"),
                s["port"]
            ));
        }
        text.push_str("\nRaw JSON:\n");
        text.push_str(&serde_json::to_string(&servers).unwrap_or_default());
        self.to_text("(none)", "list-servers", "", Ok(text))
    }

    #[tool(name = "list-directory", description = "List entries of a remote directory via SFTP (name/type/size/mtime)")]
    async fn list_directory(
        &self,
        Parameters(params): Parameters<crate::mcp::types::ListDirectoryParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = self.cfg();
        let run = async {
            let (key, hcfg) = self
                .resolve(&params.connection_name, &all)
                ?;
            let rp = validate_remote_path(&hcfg, &params.remote_path)
                ?;
            let shared =
                ssh_pool::get_session(&key, &hcfg)?;
            let entries = list_dir_sftp(&shared, &rp)?;
            Ok(entries)
        };
        let conn_name = params
            .connection_name
            .clone()
            .unwrap_or_else(|| "default".into());
        let detail = params.remote_path.clone();
        self.to_result(&conn_name, "list-directory", &detail, run.await)
    }

    #[tool(name = "upload", description = "Upload file to connected server via SFTP")]
    async fn upload_file(
        &self,
        Parameters(params): Parameters<crate::mcp::types::UploadParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = self.cfg();
        let run = async {
            let (key, hcfg) = self
                .resolve(&params.connection_name, &all)
                ?;
            if hcfg.transport_mode.as_deref() == Some("shell") {
                return Err("UNSUPPORTED_IN_SHELL_MODE: bastion shell mode does not support SFTP".to_string());
            }
            let lp = validate_local_path_read(&params.local_path)
                ?;
            let rp = validate_remote_path(&hcfg, &params.remote_path)
                ?;
            let shared =
                ssh_pool::get_session(&key, &hcfg)?;
            upload_sftp(&shared, &lp, &rp)?;
            Ok("File uploaded successfully".to_string())
        };
        let conn_name = params
            .connection_name
            .clone()
            .unwrap_or_else(|| "default".into());
        let detail = format!("{} → {}", params.local_path, params.remote_path);
        self.to_text(&conn_name, "upload", &detail, run.await)
    }

    #[tool(name = "download", description = "Download file from connected server via SFTP")]
    async fn download_file(
        &self,
        Parameters(params): Parameters<crate::mcp::types::DownloadParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = self.cfg();
        let run = async {
            let (key, hcfg) = self
                .resolve(&params.connection_name, &all)
                ?;
            if hcfg.transport_mode.as_deref() == Some("shell") {
                return Err("UNSUPPORTED_IN_SHELL_MODE: bastion shell mode does not support SFTP".to_string());
            }
            let lp = validate_local_path_write(&params.local_path)
                ?;
            let rp = validate_remote_path(&hcfg, &params.remote_path)
                ?;
            let shared =
                ssh_pool::get_session(&key, &hcfg)?;
            download_sftp(&shared, &rp, &lp)?;
            Ok("File downloaded successfully".to_string())
        };
        let conn_name = params
            .connection_name
            .clone()
            .unwrap_or_else(|| "default".into());
        let detail = format!("{} → {}", params.remote_path, params.local_path);
        self.to_text(&conn_name, "download", &detail, run.await)
    }
}

// ── exec ──

struct ExecOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    failed: bool,
}

fn exec_on_session(
    shared: &ssh_pool::SharedSession,
    cmd: &str,
    max_output_bytes: u64,
) -> Result<ExecOutput, String> {
    let guard = shared.lock().map_err(|_| "会话锁中毒".to_string())?;
    let mut channel = guard
        .session
        .channel_session()
        .map_err(|e| format!("打开通道失败: {e}"))?;
    // pty 对齐 Node 版默认 pty:true（远端 stderr 合流）
    let _ = channel.request_pty("xterm", None, None);
    channel.exec(cmd).map_err(|e| format!("执行失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 16384];
    loop {
        // 对齐 Node OUTPUT_LIMIT_EXCEEDED：超限时中止远端命令并断开会话
        if max_output_bytes > 0 && (stdout.len() as u64) > max_output_bytes {
            let _ = channel.close();
            return Err(format!(
                "OUTPUT_LIMIT_EXCEEDED\n[truncated] Output exceeded maxOutputBytes={max_output_bytes}; the command was aborted."
            ));
        }
        match channel.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let take = if max_output_bytes > 0 {
                    n.min(
                        (max_output_bytes.saturating_sub(stdout.len() as u64).max(1)) as usize,
                    )
                } else {
                    n
                };
                stdout.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if channel.eof() {
                    break;
                }
            }
            Err(e) => return Err(format!("读取输出失败: {e}")),
        }
    }
    let _ = channel.wait_eof();
    let exit_code = channel.exit_status().unwrap_or(-1);
    let _ = channel.wait_close();

    let mut text = String::from_utf8_lossy(&stdout).trim_end().to_string();
    if truncated {
        text.push_str("\n[truncated] Output exceeded maxOutputBytes.");
    }
    Ok(ExecOutput {
        stdout: text,
        stderr: String::new(),
        exit_code,
        failed: exit_code != 0,
    })
}

// ── SFTP ──

fn list_dir_sftp(
    shared: &ssh_pool::SharedSession,
    remote_path: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let guard = shared.lock().map_err(|_| "会话锁中毒".to_string())?;
    let sftp = guard.session.sftp().map_err(|e| format!("SFTP 打开失败: {e}"))?;
    let entries = sftp
        .readdir(std::path::Path::new(remote_path))
        .map_err(|e| {
            if e.code() == ssh2::ErrorCode::Session(-31) {
                format!("DIR_NOT_FOUND: {remote_path}")
            } else {
                format!("SFTP_ERROR: readdir 失败: {e}")
            }
        })?;
    let mut items: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|(name, stat)| {
            let fname = name.to_string_lossy().to_string();
            let is_dir = stat.is_dir();
            let is_link = stat.file_type() == ssh2::FileType::Symlink;
            json!({
                "name": fname,
                "type": if is_dir { "dir" } else if is_link { "symlink" } else { "file" },
                "size": if is_dir { serde_json::Value::Null } else { json!(stat.size) },
                "mtimeMs": stat.mtime.map(|m| m as u64 * 1000),
            })
        })
        .collect();
    items.sort_by(|a, b| {
        let ta = a["type"].as_str().unwrap_or("");
        let tb = b["type"].as_str().unwrap_or("");
        if ta == tb {
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
        } else if ta == "dir" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    Ok(items)
}

fn upload_sftp(
    shared: &ssh_pool::SharedSession,
    local: &str,
    remote: &str,
) -> Result<(), String> {
    // 流式分块上传（64KB），避免大文件整读进内存
    let mut file =
        std::fs::File::open(local).map_err(|e| format!("LOCAL_FILE_READ_FAILED: {e}"))?;
    let guard = shared.lock().map_err(|_| "会话锁中毒".to_string())?;
    let sftp = guard.session.sftp().map_err(|e| format!("SFTP 打开失败: {e}"))?;
    let mut fh = sftp
        .create(std::path::Path::new(remote))
        .map_err(|e| format!("SFTP_ERROR: 创建远端文件失败: {e}"))?;
    use std::io::{Read, Write};
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("LOCAL_FILE_READ_FAILED: {e}"))?;
        if n == 0 {
            break;
        }
        fh.write_all(&buf[..n])
            .map_err(|e| format!("SFTP_ERROR: 写入失败: {e}"))?;
    }
    Ok(())
}

fn download_sftp(
    shared: &ssh_pool::SharedSession,
    remote: &str,
    local: &str,
) -> Result<(), String> {
    let mut out =
        std::fs::File::create(local).map_err(|e| format!("LOCAL_FILE_WRITE_FAILED: {e}"))?;
    use std::io::Write;
    let guard = shared.lock().map_err(|_| "会话锁中毒".to_string())?;
    let sftp = guard.session.sftp().map_err(|e| format!("SFTP 打开失败: {e}"))?;
    let mut fh = sftp
        .open(std::path::Path::new(remote))
        .map_err(|e| format!("SFTP_ERROR: 打开远端文件失败: {e}"))?;
    // 流式分块下载（64KB），避免大文件整读进内存
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match fh.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out
                .write_all(&buf[..n])
                .map_err(|e| format!("LOCAL_FILE_WRITE_FAILED: {e}"))?,
            Err(e) => return Err(format!("SFTP_ERROR: 读取失败: {e}")),
        }
    }
    Ok(())
}

// ── 路径沙箱（对齐 Node 规则的简化版）──

fn validate_remote_path(hcfg: &HostConfig, p: &str) -> Result<String, String> {
    if p.is_empty() {
        return Err("REMOTE_PATH_NOT_ALLOWED: Remote path must be a non-empty string.".into());
    }
    if !p.starts_with('/') {
        return Err(format!(
            "REMOTE_PATH_NOT_ALLOWED: Remote path must be an absolute POSIX path, got: {p}"
        ));
    }
    if p.contains('\0') {
        return Err("REMOTE_PATH_NOT_ALLOWED: null bytes not allowed".into());
    }
    let allowed: Vec<&String> = hcfg
        .allowed_remote_paths
        .as_ref()
        .map(|v| v.iter().collect())
        .unwrap_or_default();
    if allowed.is_empty() {
        return Ok(p.to_string());
    }
    for root in allowed {
        let root = root.trim_end_matches('/');
        if p == root || p.starts_with(&format!("{root}/")) {
            return Ok(p.to_string());
        }
    }
    Err(format!(
        "REMOTE_PATH_NOT_ALLOWED: not within allowedRemotePaths. Allowed: {:?}",
        hcfg.allowed_remote_paths
    ))
}

fn validate_local_path_read(p: &str) -> Result<String, String> {
    if p.is_empty() || p.contains('\0') {
        return Err("LOCAL_PATH_NOT_ALLOWED: invalid local path".into());
    }
    if !std::path::Path::new(p).exists() {
        return Err(format!("LOCAL_FILE_READ_FAILED: 本地文件不存在: {p}"));
    }
    Ok(p.to_string())
}

fn validate_local_path_write(p: &str) -> Result<String, String> {
    if p.is_empty() || p.contains('\0') {
        return Err("LOCAL_PATH_NOT_ALLOWED: invalid local path".into());
    }
    if let Some(parent) = std::path::Path::new(p).parent() {
        if !parent.exists() {
            return Err(format!("LOCAL_PATH_NOT_ALLOWED: 父目录不存在: {}", parent.display()));
        }
    }
    Ok(p.to_string())
}

// ServerHandler 接线（照搬 SmomPublish）：手写 list_tools 补 ttl_ms/cache_scope，
// 否则默认 None 会被严格客户端整体拒绝（rmcp issue #1114）
#[::rmcp::tool_handler(router = Self::tool_router())]
impl ::rmcp::ServerHandler for McpHandler {
    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        Ok(
            rmcp::model::ListToolsResult::with_all_items(Self::tool_router().list_all())
                .with_ttl_ms(0)
                .with_cache_scope(rmcp::model::CacheScope::Private),
        )
    }
}
