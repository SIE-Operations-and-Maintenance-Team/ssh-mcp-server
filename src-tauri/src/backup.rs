//! 备份快照 / 保留策略清理 / 定时调度（对齐 Node 端 backup-service + backup-scheduler 语义）。
//! 注意：Windows 上文件复制会保留源文件 mtime，因此列表展示与排序一律以文件名内嵌时间戳为准。

use crate::config;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 检查间隔：每 10 分钟检查一次是否该备份（对齐 Node CHECK_INTERVAL_MS，
/// 用短周期轮询代替长 sleep，配置变更后下一轮即生效）
const CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);

pub fn backups_dir() -> PathBuf {
    config::config_path()
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("backups")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 当前 UTC 时间的文件名片段：2026-08-26T15-30-00-000Z 形式（对齐 Node toISOString replace [:.]→-）
pub fn now_filename() -> String {
    let now = now_ms();
    let days = (now / 86_400_000) as i64;
    let rem = now % 86_400_000;
    let (h, mi, s, ms) = (
        rem / 3_600_000,
        (rem % 3_600_000) / 60_000,
        (rem % 60_000) / 1000,
        rem % 1000,
    );
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{h:02}-{mi:02}-{s:02}-{ms:03}Z")
}

/// 从备份文件名解析创建时间（epoch ms，UTC）；非标准命名返回 None
pub fn ts_from_name(name: &str) -> Option<u64> {
    let base = name.strip_prefix("config-")?.strip_suffix("Z.json")?;
    let parts: Vec<Option<u64>> = base
        .split(|c| c == 'T' || c == '-')
        .map(|p| p.parse().ok())
        .collect();
    if parts.len() != 7 || parts.iter().any(|p| p.is_none()) {
        return None;
    }
    let nums: Vec<u64> = parts.into_iter().map(|p| p.unwrap()).collect();
    let (y, mo, d, h, mi, s, ms) = (
        nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], nums[6],
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y as i64, mo as u32, d as u32);
    Some(
        (days * 86_400_000 + (h * 3_600_000 + mi * 60_000 + s * 1000 + ms) as i64) as u64,
    )
}

/// 列出备份文件（.json），按文件名降序（新→旧，零填充 UTC 命名下字典序即时间序）
pub fn list_files() -> Vec<(PathBuf, u64)> {
    let dir = backups_dir();
    let mut files: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .map(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let ts = ts_from_name(&name).unwrap_or(0);
                    (p, ts)
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
}

/// 创建当前配置的快照，返回备份文件名（不做清理，调用方按需调用 prune）
pub fn do_snapshot() -> Result<String, String> {
    let dir = backups_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("config-{}.json", now_filename());
    let dst = dir.join(&name);
    let src = config::config_path();
    if src.exists() {
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    } else {
        let cfg = config::load();
        let j = serde_json::to_string_pretty(&cfg).unwrap_or_default();
        std::fs::write(&dst, j).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

/// 按保留策略清理：先按 retentionDays 删过期，再按 maxCount 截断最旧（对齐 Node BackupService.prune）。
/// 返回被删除的文件名列表
pub fn prune(retention_days: Option<u32>, max_count: Option<u32>) -> Vec<String> {
    let mut deleted: Vec<String> = Vec::new();
    if let Some(days) = retention_days.filter(|d| *d > 0) {
        let cutoff = now_ms().saturating_sub(days as u64 * 86_400_000);
        for (p, ts) in list_files() {
            // ts=0 表示文件名无法解析时间，与 Node 一致跳过过期判断
            if ts > 0 && ts < cutoff {
                if let Some(name) = remove_ok(&p) {
                    deleted.push(name);
                }
            }
        }
    }
    if let Some(max) = max_count.filter(|m| *m > 0) {
        let remaining = list_files();
        if remaining.len() > max as usize {
            for (p, _) in remaining.into_iter().skip(max as usize) {
                if let Some(name) = remove_ok(&p) {
                    deleted.push(name);
                }
            }
        }
    }
    deleted
}

fn remove_ok(p: &std::path::Path) -> Option<String> {
    let name = p.file_name().map(|n| n.to_string_lossy().to_string());
    match std::fs::remove_file(p) {
        Ok(()) => name,
        Err(_) => None,
    }
}

/// 应用启动时调用：先按当前配置清一次历史积压（旧版本从不清理，可能已远超 maxCount），
/// 之后每 10 分钟检查一次，距上次备份达到 interval_hours 即快照 + 清理
pub fn spawn_scheduler() {
    tauri::async_runtime::spawn(async {
        let cfg = config::load();
        if let Some(b) = &cfg.backups {
            let removed = prune(b.retention_days, b.max_count);
            if !removed.is_empty() {
                eprintln!("[backup-scheduler] startup prune removed {} backup(s)", removed.len());
            }
        }
        let mut last_backup = Instant::now();
        loop {
            tokio::time::sleep(CHECK_INTERVAL).await;
            let cfg = config::load();
            let Some(b) = cfg.backups.clone() else { continue };
            if !b.auto_enabled.unwrap_or(false) {
                continue;
            }
            let hours = b.interval_hours.unwrap_or(24).max(1) as u64;
            if last_backup.elapsed() >= Duration::from_secs(hours * 3600) {
                match do_snapshot() {
                    Ok(_) => {
                        prune(b.retention_days, b.max_count);
                        last_backup = Instant::now();
                        eprintln!("[backup-scheduler] auto snapshot done");
                    }
                    Err(e) => eprintln!("[backup-scheduler] auto snapshot failed: {e}"),
                }
            }
        }
    });
}

// ── 民用日历换算（Howard Hinnant 算法，与原 admin_http 实现一致）──

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_from_name_parses_utc() {
        // 2026-08-26T03:10:00.930Z = 20691 天(自 1970-01-01) * 86400000 + 3h10m0.930s
        let expect = 20_691u64 * 86_400_000 + 3 * 3_600_000 + 10 * 60_000 + 930;
        assert_eq!(ts_from_name("config-2026-08-26T03-10-00-930Z.json"), Some(expect));
    }

    #[test]
    fn ts_from_name_rejects_nonstandard() {
        assert!(ts_from_name("manual-copy.json").is_none());
        assert!(ts_from_name("config-bad.json").is_none());
    }

    #[test]
    fn now_filename_roundtrip() {
        let name = format!("config-{}.json", now_filename());
        assert!(ts_from_name(&name).is_some());
    }
}
