//! 系统托盘（菜单结构对齐 MCP-DB-Tools TrayHost：
//! 打开管理页 / 关于 / 重启服务 / 退出，双击托盘图标同样打开管理页；
//! 纯托盘模式——无 WebView 主窗口，管理页一律在系统默认浏览器中打开）。

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 本地服务当前监听端口（未启动返回 None）
fn service_port() -> Option<u16> {
    *crate::mcp::manager::bound_port()
}

/// 用系统默认浏览器打开 Admin 页（对齐 MCP-DB-Tools OpenAdmin：失败不阻断，仅记日志）
pub fn open_admin() {
    let Some(port) = service_port() else {
        eprintln!("[tray] 服务未就绪，无法打开管理页");
        return;
    };
    let url = format!("http://127.0.0.1:{port}/admin/");
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        eprintln!("[tray] 打开管理页失败: {e}");
    }
}

/// "关于"弹窗：版本 + Admin/MCP 地址（对齐 MCP-DB-Tools ShowAbout）
fn show_about(app: &AppHandle) {
    let ver = app.package_info().version.clone();
    let detail = match service_port() {
        Some(p) => format!(
            "SSH MCP Server v{ver}\n\nAdmin UI: http://127.0.0.1:{p}/admin\nMCP:      http://127.0.0.1:{p}/mcp"
        ),
        None => format!("SSH MCP Server v{ver}\n\n（本地服务未运行）"),
    };
    app.dialog()
        .message(detail)
        .title("关于 SSH MCP Server")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// 触发软重启（对齐 admin_api /admin/api/restart 与 MCP-DB-Tools RestartHelper）
fn restart_app(app: &AppHandle) {
    app.restart();
}

pub fn ssh_menu(app: &AppHandle) -> tauri::Result<()> {
    let ver = app.package_info().version.clone();
    let open = MenuItem::with_id(app, "open-admin", "打开管理页", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let about_label = format!("关于 SSH MCP Server  v{ver}");
    let about = MenuItem::with_id(
        app,
        "about",
        about_label.as_str(),
        true,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &about, &restart, &quit])?;
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(format!("SSH MCP Server v{ver}"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-admin" => open_admin(),
            "about" => show_about(app),
            "restart" => restart_app(app),
            "quit" => {
                crate::mcp::manager::stop_after_run();
                std::process::exit(0);
            }
            _ => {}
        })
        // 双击托盘图标 → 系统浏览器打开管理页
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                open_admin();
            }
        })
        .build(app)?;
    Ok(())
}
