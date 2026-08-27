//! 内存审计日志（桌面壳简化版：RingBuffer 上限 5000 条；
//! SQLite 持久化为后续迭代项，API 形状与 Node 版 query 一致）。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: u64,
    pub ts: u64,
    pub connection: String,
    pub tool: String,
    pub status: String,
}

static AUDIT: Mutex<Vec<AuditEntry>> = Mutex::new(Vec::new());
static NEXT_ID: Mutex<u64> = Mutex::new(1);

/// 返回 false 表示审计被配置关闭
pub fn log(_app: &AppHandle, connection: &str, tool: &str, ok: bool) -> bool {
    let cfg = crate::config::load();
    let audit = cfg.audit.unwrap_or_default();
    if audit.enabled == Some(false) {
        return false;
    }
    if ok && audit.log_results == Some(false) {
        return false;
    }
    let mut next = NEXT_ID.lock().unwrap();
    let entry = AuditEntry {
        id: *next,
        ts: now_ms(),
        connection: connection.to_string(),
        tool: tool.to_string(),
        status: if ok { "ok".into() } else { "fail".into() },
    };
    *next += 1;
    drop(next);
    if let Ok(mut v) = AUDIT.lock() {
        v.push(entry);
        // RingBuffer：超过上限丢弃最旧
        const MAX: usize = 5000;
        if v.len() > MAX {
            let cut = v.len() - MAX;
            v.drain(0..cut);
        }
    }
    true
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 分页查询（对齐 Node 版语义）
pub fn query(
    page: usize,
    page_size: usize,
    q: Option<&str>,
    connection: Option<&str>,
    tool: Option<&str>,
    status: Option<&str>,
) -> serde_json::Value {
    _ = app_query_hint();
    let rows = AUDIT.lock().map(|v| v.clone()).unwrap_or_default();
    let q_lower = q.map(|s| s.to_lowercase());
    let filtered: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            if let Some(ql) = &q_lower {
                let hay = format!("{} {} {}", r.connection, r.tool, r.status).to_lowercase();
                if !hay.contains(ql) {
                    return false;
                }
            }
            if let Some(c) = connection {
                if r.connection != c {
                    return false;
                }
            }
            if let Some(t) = tool {
                if r.tool != t {
                    return false;
                }
            }
            if let Some(s) = status {
                if r.status != s {
                    return false;
                }
            }
            true
        })
        .collect();
    let total = filtered.len();
    let page_size = page_size.clamp(1, 100);
    let page = page.max(1);
    let start = (page - 1) * page_size;
    let sliced: Vec<_> = filtered
        .into_iter()
        .rev()
        .skip(start)
        .take(page_size)
        .collect();
    serde_json::json!({ "total": total, "rows": sliced, "page": page, "pageSize": page_size })
}

// 保持签名独立于 AppHandle（admin_http 直接调用），此处占位避免无用参数告警
fn app_query_hint() {}
