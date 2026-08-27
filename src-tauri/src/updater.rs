//! 应用自更新（HTTP API 封装 tauri-plugin-updater）。
//!
//! 前端 System 页通过 fetch 调用（与 Node 版 API 形状对齐）：
//! - GET  /admin/api/update/status → { currentVersion, configured, installed, checked, hasUpdate, targetVersion }
//! - POST /admin/api/update/check  → 拉 endpoint latest.json 并比较版本
//! - POST /admin/api/update/apply  → 后台下载+验签+安装+自动重启
//!
//! 桌面壳单 exe 即完整安装形态，在线更新恒可用（installed=true）。

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// check 结果暂存 + 待安装对象
struct UpdateState {
    checked: bool,
    has_update: bool,
    target_version: String,
    error: Option<String>,
}

static STATE: std::sync::OnceLock<std::sync::Mutex<UpdateState>> = std::sync::OnceLock::new();

fn state() -> &'static std::sync::Mutex<UpdateState> {
    STATE.get_or_init(|| {
        std::sync::Mutex::new(UpdateState {
            checked: false,
            has_update: false,
            target_version: String::new(),
            error: None,
        })
    })
}

pub fn is_checked() -> bool {
    state().lock().map(|s| s.checked).unwrap_or(false)
}

fn semver_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|n| n.parse().unwrap_or(0))
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..3 {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

pub async fn status(app: AppHandle) -> serde_json::Value {
    let mut body = serde_json::json!({
        "currentVersion": app.package_info().version.to_string(),
        "installed": true,
        "configured": true,
        "checked": false,
        "hasUpdate": false,
        "targetVersion": "",
        "downloaded": false,
        "error": null,
    });
    if let Ok(s) = state().lock() {
        if s.checked {
            body["checked"] = serde_json::json!(s.checked);
            body["hasUpdate"] = serde_json::json!(s.has_update);
            body["targetVersion"] = serde_json::json!(s.target_version);
            body["error"] = serde_json::json!(s.error);
        }
    }
    body
}

pub async fn check(app: AppHandle) -> serde_json::Value {
    let current = app.package_info().version.to_string();
    let result = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    match result {
        Ok(Some(update)) => {
            let has = semver_compare(&update.version, &current) == std::cmp::Ordering::Greater;
            let ver = update.version.clone();
            if let Ok(mut s) = state().lock() {
                s.checked = true;
                s.has_update = has;
                s.target_version = ver.clone();
                s.error = None;
            }
            eprintln!(
                "[update] checked: latest={ver}, current={current}, hasUpdate={has}"
            );
        }
        Ok(None) => {
            if let Ok(mut s) = state().lock() {
                s.checked = true;
                s.has_update = false;
                s.target_version = current.clone();
                s.error = None;
            }
            eprintln!("[update] checked: already latest ({current})");
        }
        Err(e) => {
            if let Ok(mut s) = state().lock() {
                s.checked = true;
                s.has_update = false;
                s.error = Some(e.to_string());
            }
            eprintln!("[update] check failed: {e}");
        }
    }
    status(app).await
}

/// 后台执行：下载+验签+安装+自动重启。HTTP 层立即返回 applying:true。
pub fn spawn_apply(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 应用进程内保存的待装信息仅用于日志判断；实际下载由 Updater 重新构建
        let (has_target, target_ver) = match state().lock() {
            Ok(s) => (s.has_update, s.target_version.clone()),
            Err(_) => (false, String::new()),
        };
        if !has_target {
            eprintln!("[update] 没有待安装的更新（请先 check）");
            return;
        }
        eprintln!("[update] 开始下载 v{target_ver} ...");
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[update] updater 初始化失败: {e}");
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) if u.version == target_ver => u,
            Ok(Some(u)) => {
                eprintln!(
                    "[update] 远端版本已变化({} != {})，请重新检查",
                    u.version, target_ver
                );
                return;
            }
            Ok(None) => {
                eprintln!("[update] 无可用更新");
                return;
            }
            Err(e) => {
                eprintln!("[update] apply 前置检查失败: {e}");
                return;
            }
        };
        let mut last_mb = 0u64;
        if let Err(e) = update
            .download_and_install(
                |chunk, total| {
                    last_mb += chunk as u64;
                    if let Some(t) = total {
                        if last_mb >= 1024 * 1024 || chunk == t as usize {
                            eprintln!(
                                "[update] 进度 {:.1}MB / {}MB",
                                chunk as f64 / 1048576.0,
                                t / 1048576
                            );
                        }
                    }
                },
                || eprintln!("[update] 下载完成，验签并安装..."),
            )
            .await
        {
            eprintln!("[update] 下载/安装失败: {e}");
            return;
        }
        eprintln!("[update] 安装完成，正在重启到新版本...");
        std::process::exit(0);
    });
}
