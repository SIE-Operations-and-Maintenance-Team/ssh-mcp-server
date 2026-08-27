pub mod handler;
pub mod manager;
pub mod types;

use crate::admin_http;
use rmcp::transport::streamable_http_server::{session::local::LocalSessionManager, StreamableHttpService};

/// 启动统一服务：同端口承载 `/mcp`（rmcp StreamableHTTP）+ `/admin/`（静态 dist）+ `/admin/api/*`。
/// 对齐 Node 版"同端口"语义；由 manager 负责启停。
pub async fn serve(app_handle: tauri::AppHandle, port: u16) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("端口 {port} 绑定失败: {e}"))?;

    eprintln!("[server] listening on http://127.0.0.1:{port}/admin/  (MCP: /mcp)");

    let handler_app = app_handle.clone();
    let service = StreamableHttpService::<handler::McpHandler, LocalSessionManager>::new(
        move || Ok(handler::McpHandler::new(handler_app.clone())),
        Default::default(),
        Default::default(),
    );

    let router = admin_http::build_router(app_handle.clone(), service);
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("服务退出: {e}"))
}
