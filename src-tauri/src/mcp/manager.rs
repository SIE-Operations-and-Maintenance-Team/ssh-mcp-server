//! MCP 服务运行时管理（照搬 SmomPublish mcp/manager.rs：watch channel + 管理循环）。

use crate::config;
use crate::mcp::serve;
use std::sync::Mutex;
use tokio::sync::watch;

static MCP_WATCH_SENDER: Mutex<Option<watch::Sender<()>>> = Mutex::new(None);

/// 当前已绑定端口（admin_http system/info 用；None 表示未启动）
static BOUND_PORT: Mutex<Option<u16>> = Mutex::new(None);

pub fn bound_port() -> std::sync::MutexGuard<'static, Option<u16>> {
    BOUND_PORT.lock().unwrap_or_else(|p| p.into_inner())
}

fn set_bound_port(port: Option<u16>) {
    if let Ok(mut g) = BOUND_PORT.lock() {
        *g = port;
    }
}

/// 供 admin API 在配置保存后通知管理循环重启（换端口等）
pub fn notify_external_change() {
    notify_change();
}

fn set_sender(sender: watch::Sender<()>) {
    if let Ok(mut guard) = MCP_WATCH_SENDER.lock() {
        *guard = Some(sender);
    }
}

fn notify_change() {
    if let Ok(guard) = MCP_WATCH_SENDER.lock() {
        if let Some(sender) = guard.as_ref() {
            let _ = sender.send(());
        }
    }
}

fn spawn_serve_task(
    app_handle: &tauri::AppHandle,
    port: u16,
) -> tokio::task::JoinHandle<Result<(), String>> {
    set_bound_port(Some(port));
    let handle = app_handle.clone();
    tokio::spawn(async move {
        let r = serve(handle, port).await;
        if r.is_err() {
            set_bound_port(None);
        }
        notify_change();
        r
    })
}

async fn manager_loop(app_handle: tauri::AppHandle, mut rx: watch::Receiver<()>) {
    let mut running: Option<(tokio::task::JoinHandle<Result<(), String>>, u16)> = None;

    loop {
        if rx.changed().await.is_err() {
            break;
        }
        // 清理已结束任务（端口占用等失败时重试一次下一轮）
        if let Some((task, port)) = running.take() {
            if task.is_finished() {
                match task.await {
                    Ok(Err(e)) => eprintln!("[mcp] {e}"),
                    _ => {}
                }
            } else {
                running = Some((task, port));
                continue;
            }
        }
        let cfg = config::load();
        let port = cfg.admin_port();
        match running.as_ref() {
            Some((_, running_port)) if *running_port != port => {
                // 端口变更：重启
                if let Some((task, _)) = running.take() {
                    task.abort();
                }
                running = Some((spawn_serve_task(&app_handle, port), port));
            }
            None => {
                running = Some((spawn_serve_task(&app_handle, port), port));
            }
            _ => {}
        }
    }

    if let Some((task, _)) = running.take() {
        task.abort();
    }
}

/// 应用启动时初始化管理循环
pub fn init(app_handle: &tauri::AppHandle) {
    let (sender, receiver) = watch::channel(());
    set_sender(sender);
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move { manager_loop(handle, receiver).await });
    notify_change();
    // 定时备份调度（快照 + 保留策略清理）
    crate::backup::spawn_scheduler();
}

/// 配置变更后调用：按新配置启停/换端口
pub fn apply(_app_handle: &tauri::AppHandle) {
    notify_change();
}

/// 应用退出清理
pub fn stop_after_run() {
    if let Ok(guard) = MCP_WATCH_SENDER.lock() {
        if let Some(sender) = guard.as_ref() {
            let _ = sender.send(());
        }
    }
}
