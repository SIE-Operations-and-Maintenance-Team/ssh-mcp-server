//! MCP 工具参数类型（rmcp schemars 推导 JSON Schema）。

use rmcp::schemars;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteCommandParam {
    /// 要执行的命令
    pub cmd_string: String,
    /// 工作目录（可选，先 cd 再执行）
    #[serde(default)]
    pub directory: Option<String>,
    /// 连接名：`project/env/host` 或全局唯一主机名简写；缺省取第一个连接
    #[serde(default)]
    pub connection_name: Option<String>,
    /// 命令超时毫秒；缺省用连接配置 commandTimeoutMs（默认 30000）
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionNameParam {
    /// 连接名（可选）
    #[serde(default)]
    pub connection_name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDirectoryParam {
    /// 远端绝对 POSIX 目录路径
    pub remote_path: String,
    #[serde(default)]
    pub connection_name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UploadParam {
    /// 本地文件路径
    pub local_path: String,
    /// 远端目标绝对 POSIX 路径
    pub remote_path: String,
    #[serde(default)]
    pub connection_name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DownloadParam {
    /// 远端源文件绝对 POSIX 路径
    pub remote_path: String,
    /// 本地保存路径
    pub local_path: String,
    #[serde(default)]
    pub connection_name: Option<String>,
}
