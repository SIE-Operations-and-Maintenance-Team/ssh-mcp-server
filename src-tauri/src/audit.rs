//! 桌面版审计日志：SQLite 持久化（对齐 Node 版 audit-store 的表结构与查询语义）。
//!
//! 库文件：`%ProgramData%\SshMcpServer\audit.db`，与 config.json 同目录——NSIS
//! 升级/重装不触碰该目录，审计记录跨升级保留。此前实现为内存 RingBuffer，
//! 任何进程重启（升级/托盘重启服务/崩溃/关机）都会清空审计记录，
//! 见 doc/bug-diagnosis-audit-memory-loss-20260901.md。
//!
//! - `log()`：同步 INSERT；配置了 retention_days 时顺带清理过期行（对齐 Node 版写入时清理）
//! - `query()`：SQL 过滤 + 分页，返回形状与 Node 版一致 `{ total, rows, page, pageSize }`
//! - 库打开/写入失败时静默降级为空结果（与 Node 版 catch{} 容错策略一致），不影响 MCP 执行

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: u64,
    pub ts: u64,
    pub connection: String,
    pub tool: String,
    pub status: String,
    /// 命令 / 路径明细（对齐 Node 版 AuditEntry.sql，供审计页预览）
    #[serde(default)]
    pub sql: String,
}

/// 全局唯一连接。懒初始化：首次使用时打开；打开失败保持 None，下次操作自动重试。
static DB: Mutex<Option<Connection>> = Mutex::new(None);

fn db_path() -> std::path::PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    Path::new(&base).join("SshMcpServer").join("audit.db")
}

fn open_db() -> Option<Connection> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(&path).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER,
            connection TEXT,
            tool TEXT,
            status TEXT,
            sql TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);",
    )
    .ok()?;
    Some(conn)
}

/// 在审计库连接上执行操作；未打开时先懒初始化，仍失败则返回 None。
fn with_db<T>(f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
    let mut guard = DB.lock().ok()?;
    if guard.is_none() {
        *guard = open_db();
    }
    let conn = guard.as_ref()?;
    f(conn).ok()
}

/// 返回 false 表示审计被配置关闭
pub fn log(_app: &AppHandle, connection: &str, tool: &str, ok: bool, detail: &str) -> bool {
    let cfg = crate::config::load();
    let audit = cfg.audit.unwrap_or_default();
    if audit.enabled == Some(false) {
        return false;
    }
    if ok && audit.log_results == Some(false) {
        return false;
    }
    let ts = now_ms();
    let retention = audit.retention_days.unwrap_or(0);
    with_db(|conn| insert_entry(conn, ts, connection, tool, ok, detail, retention));
    true
}

/// 分页查询（对齐 Node 版语义与返回形状）
pub fn query(
    page: usize,
    page_size: usize,
    q: Option<&str>,
    connection: Option<&str>,
    tool: Option<&str>,
    status: Option<&str>,
) -> serde_json::Value {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 100);
    let empty =
        || serde_json::json!({ "total": 0, "rows": [], "page": page, "pageSize": page_size });
    match with_db(|conn| query_conn(conn, page, page_size, q, connection, tool, status)) {
        Some((total, rows)) => {
            serde_json::json!({ "total": total, "rows": rows, "page": page, "pageSize": page_size })
        }
        None => empty(),
    }
}

fn insert_entry(
    conn: &Connection,
    ts: u64,
    connection: &str,
    tool: &str,
    ok: bool,
    detail: &str,
    retention_days: u32,
) -> rusqlite::Result<()> {
    if retention_days > 0 {
        let cutoff = ts as i64 - retention_days as i64 * 24 * 3600 * 1000;
        conn.execute("DELETE FROM audit WHERE ts < ?1", [cutoff])?;
    }
    conn.execute(
        "INSERT INTO audit (ts, connection, tool, status, sql) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            ts as i64,
            connection,
            tool,
            if ok { "ok" } else { "fail" },
            detail
        ],
    )?;
    Ok(())
}

fn query_conn(
    conn: &Connection,
    page: usize,
    page_size: usize,
    q: Option<&str>,
    connection: Option<&str>,
    tool: Option<&str>,
    status: Option<&str>,
) -> rusqlite::Result<(i64, Vec<AuditEntry>)> {
    let mut clauses: Vec<&str> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    if let Some(ql) = q.map(str::trim).filter(|s| !s.is_empty()) {
        // SQLite LIKE 对 ASCII 不区分大小写，对齐 Node 版 DB 查询语义
        clauses.push("(connection LIKE ? OR tool LIKE ? OR sql LIKE ?)");
        let like = format!("%{}%", ql);
        params.push(like.clone());
        params.push(like.clone());
        params.push(like);
    }
    if let Some(c) = connection.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push("connection = ?");
        params.push(c.to_string());
    }
    if let Some(t) = tool.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push("tool = ?");
        params.push(t.to_string());
    }
    if let Some(s) = status.map(str::trim).filter(|s| !s.is_empty()) {
        clauses.push("status = ?");
        params.push(s.to_string());
    }
    let clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM audit {}", clause),
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;

    // limit/offset 已 clamp 为 usize，直接内插无注入面
    let sql = format!(
        "SELECT id, ts, connection, tool, status, sql FROM audit {} ORDER BY ts DESC LIMIT {} OFFSET {}",
        clause,
        page_size,
        (page - 1) * page_size
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(AuditEntry {
                id: row.get::<_, i64>(0)? as u64,
                ts: row.get::<_, i64>(1)? as u64,
                connection: row.get(2)?,
                tool: row.get(3)?,
                status: row.get(4)?,
                sql: row.get(5).unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((total, rows))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER, connection TEXT, tool TEXT, status TEXT, sql TEXT
            );
            CREATE INDEX audit_ts ON audit(ts);",
        )
        .unwrap();
        conn
    }

    fn add(conn: &Connection, ts: u64, tool: &str, ok: bool, sql: &str) {
        insert_entry(conn, ts, "proj/env/host", tool, ok, sql, 0).unwrap();
    }

    #[test]
    fn 写入后可查询且按时间倒序() {
        let conn = mem_db();
        add(&conn, 1000, "execute-command", true, "ls -la");
        add(&conn, 2000, "upload", true, "a.txt -> b.txt");
        let (total, rows) = query_conn(&conn, 1, 20, None, None, None, None).unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows[0].tool, "upload"); // ts 更大者在前
        assert_eq!(rows[0].id, 2);
    }

    #[test]
    fn 重启后数据仍在_模拟持久化() {
        // 同一个库文件被两个连接先后打开 = 应用重启后的读取场景
        let path = std::env::temp_dir().join(format!("audit-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, connection TEXT, tool TEXT, status TEXT, sql TEXT);").unwrap();
            insert_entry(&conn, 123, "c", "execute-command", true, "dir", 0).unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            let (total, rows) = query_conn(&conn, 1, 20, None, None, None, None).unwrap();
            assert_eq!(total, 1);
            assert_eq!(rows[0].sql, "dir");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retention_清理过期记录() {
        let conn = mem_db();
        let now = now_ms();
        add(&conn, now - 40 * 24 * 3600 * 1000, "old", true, "old-cmd"); // 40 天前，超出 30 天保留期
        add(&conn, now, "new", true, "new-cmd");
        insert_entry(&conn, now, "proj/env/host", "trigger", true, "x", 30).unwrap(); // retention=30 天
        let (total, _) = query_conn(&conn, 1, 20, None, None, None, None).unwrap();
        assert_eq!(total, 2); // 40 天前那条被清掉，剩 new + trigger
    }

    #[test]
    fn 关键字过滤命中命令明细() {
        let conn = mem_db();
        add(&conn, 1000, "execute-command", true, "docker ps -a");
        add(&conn, 2000, "upload", true, "report.xlsx");
        let (total, rows) = query_conn(&conn, 1, 20, Some("docker"), None, None, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].tool, "execute-command");
    }

    #[test]
    fn status_与_工具_精确过滤() {
        let conn = mem_db();
        add(&conn, 1000, "execute-command", true, "ok-cmd");
        add(&conn, 2000, "execute-command", false, "fail-cmd");
        add(&conn, 3000, "upload", true, "file");
        let (_, rows) = query_conn(&conn, 1, 20, None, None, Some("execute-command"), Some("fail")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "fail");
    }

    #[test]
    fn 分页边界() {
        let conn = mem_db();
        for i in 0..25 {
            add(&conn, i as u64, "t", true, &format!("cmd-{}", i));
        }
        let (total, rows) = query_conn(&conn, 2, 10, None, None, None, None).unwrap();
        assert_eq!(total, 25);
        assert_eq!(rows.len(), 10);
        assert_eq!(rows[0].sql, "cmd-14"); // 第 2 页从第 11 条开始（倒序）
    }
}
