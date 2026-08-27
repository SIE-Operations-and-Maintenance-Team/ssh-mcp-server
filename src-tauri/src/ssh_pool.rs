//! SSH 会话连接池（移植自 SmomPublish cmd_module/ssh_pool.rs，key 改为连接名）。
//!
//! - 以扁平连接名（`project/env/host`）为 key 缓存 `ssh2::Session`
//! - 取用前 authenticated + keepalive 双重探活；空闲超 IDLE_TIMEOUT 重建
//! - libssh2 同一 Session 不支持并发使用，通过 Arc<Mutex> 串行化

use crate::config::HostConfig;
use ssh2::Session;
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct PooledSession {
    pub session: Session,
    pub last_used: Instant,
}

pub type SharedSession = Arc<Mutex<PooledSession>>;

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

static POOL: OnceLock<Mutex<HashMap<String, SharedSession>>> = OnceLock::new();

fn pool() -> &'static Mutex<HashMap<String, SharedSession>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 获取一个已认证的会话；不可用则按 HostConfig 重建。
/// 认证顺序对齐 Node 版 buildClientConfig：私钥 → agent → 密码。
pub fn get_session(key: &str, cfg: &HostConfig) -> Result<SharedSession, String> {
    let existing = {
        let map = pool().lock().map_err(|_| "SSH 连接池锁中毒".to_string())?;
        map.get(key).cloned()
    };
    if let Some(shared) = existing {
        let healthy = shared
            .lock()
            .map(|e| {
                e.last_used.elapsed() < IDLE_TIMEOUT
                    && e.session.authenticated()
                    && e.session.keepalive_send().is_ok()
            })
            .unwrap_or(false);
        if healthy {
            if let Ok(mut e) = shared.lock() {
                e.last_used = Instant::now();
            }
            return Ok(shared);
        }
        let mut map = pool().lock().map_err(|_| "SSH 连接池锁中毒".to_string())?;
        if let Some(cur) = map.get(key) {
            if Arc::ptr_eq(cur, &shared) {
                map.remove(key);
            }
        }
    }

    // 新建：TCP → 握手 → 认证 → keepalive
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let timeout = Duration::from_millis(cfg.connection_timeout_ms.unwrap_or(30_000));
    let tcp = TcpStream::connect_timeout(
        &addr
            .to_socket_addrs_any()
            .map_err(|e| format!("解析地址失败 {addr}: {e}"))?,
        timeout,
    )
    .map_err(|e| format!("SSH_CONNECTION_FAILED: 无法连接 {addr}: {e}"))?;
    tcp.set_read_timeout(Some(timeout)).ok();
    tcp.set_write_timeout(Some(timeout)).ok();

    let mut sess =
        Session::new().map_err(|e| format!("SSH_CONNECTION_FAILED: 创建会话失败: {e}"))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH_CONNECTION_FAILED: 握手失败 [{key}]: {e}"))?;

    // 认证：私钥 → agent → 密码（keyboard-interactive 作为密码补充）
    if let Some(pk) = &cfg.private_key {
        let pk_path = expand_home(pk);
        let passphrase = cfg.passphrase.as_deref();
        sess.userauth_pubkey_file(
            &cfg.username,
            None,
            std::path::Path::new(&pk_path),
            passphrase,
        )
        .map_err(|e| format!("SSH_AUTHENTICATION_FAILED: 私钥认证失败: {e}"))?;
    } else if let Some(_agent) = &cfg.agent {
        // libssh2 Windows 上无标准 agent 通道，回退到提示
        return Err("SSH_AUTHENTICATION_FAILED: 桌面壳暂不支持 SSH Agent 认证，请改用密码或私钥".into());
    }

    if !sess.authenticated() {
        if let Some(password) = &cfg.password {
            sess.userauth_password(&cfg.username, password)
                .map_err(|_| "SSH_AUTHENTICATION_FAILED: 密码认证失败".to_string())?;
        }
    }

    if !sess.authenticated() {
        return Err(format!(
            "SSH_AUTHENTICATION_MISSING: [{key}] 未提供有效认证方式或认证失败"
        ));
    }

    // keepalive 秒级取整，至少 1 秒（避免亚秒配置得到 0 导致异常发包）
    sess.set_keepalive(
        true,
        (cfg.keepalive_interval_ms.unwrap_or(10_000) / 1000).max(1),
    );

    let shared = Arc::new(Mutex::new(PooledSession {
        session: sess,
        last_used: Instant::now(),
    }));
    pool()
        .lock()
        .map_err(|_| "SSH 连接池锁中毒".to_string())?
        .insert(key.to_string(), shared.clone());
    Ok(shared)
}

/// 命令级超时：设置在 Session 上（libssh2 阻塞模式超时，毫秒）
pub fn set_command_timeout(shared: &SharedSession, ms: i64) {
    if let Ok(e) = shared.lock() {
        e.session.set_timeout(if ms > 0 { ms as u32 } else { 0 });
    }
}

pub fn invalidate(key: &str) {
    if let Ok(mut map) = pool().lock() {
        map.remove(key);
    }
}

pub fn clear() {
    if let Ok(mut map) = pool().lock() {
        map.clear();
    }
}

fn expand_home(p: &str) -> String {
    if p == "~" {
        return home_dir();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return format!("{}/{}", home_dir(), rest);
    }
    p.to_string()
}

fn home_dir() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_else(|_| ".".into())
}

trait ToSocketAddrsAny {
    fn to_socket_addrs_any(&self) -> std::io::Result<std::net::SocketAddr>;
}

impl ToSocketAddrsAny for String {
    fn to_socket_addrs_any(&self) -> std::io::Result<std::net::SocketAddr> {
        use std::net::ToSocketAddrs;
        self.to_socket_addrs()?.next().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "no address resolved")
        })
    }
}
