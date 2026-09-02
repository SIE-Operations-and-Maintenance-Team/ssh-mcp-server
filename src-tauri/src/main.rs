// Tauri 2 桌面壳（架构对齐 SmomPublish + 托盘菜单对齐 MCP-DB-Tools TrayHost）：
// 单 exe —— SSH 连接池 / MCP StreamableHTTP / Admin 静态站点全部内置本进程。
// 纯托盘模式：无 WebView 主窗口，"打开管理页"在系统默认浏览器中打开。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ssh_mcp_server_gui::{mcp, tray};

fn main() {
    tauri::Builder::default()
        // 系统浏览器/外链打开能力：托盘菜单 Rust API 直调
        .plugin(tauri_plugin_opener::init())
        // 托盘"关于"弹窗（Rust API 直调）
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // 二次启动：无窗口可前置，直接在系统浏览器打开管理页
            tray::open_admin();
        }))
        .setup(|app| {
            // 存量数据迁移：修复历史导入产生的主机 name 缺失（落盘，幂等）
            ssh_mcp_server_gui::config::migrate();

            // 托盘
            tray::ssh_menu(app.handle()).expect("初始化托盘失败");

            // 启动统一服务（/mcp + /admin 静态 + /admin/api）
            mcp::manager::init(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 SSH MCP Server 出错");

    mcp::manager::stop_after_run();
}
