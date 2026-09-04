<div align="center">

<img src="images/logo.png" alt="ssh-mcp-server logo" width="160">

# SSH MCP Server

**让 AI 客户端安全地操作你的服务器 —— 基于 SSH 的 MCP 服务器**

通过标准化 MCP 工具在远端执行命令与传输文件，内置 Web 管理台与 Windows 托盘应用。

[![Release](https://img.shields.io/github/v/release/SIE-Operations-and-Maintenance-Team/ssh-mcp-server)](https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/releases)

</div>

## 它能做什么

把 Claude Code、Cursor 等支持 MCP 协议的 AI 客户端连到你的 SSH 服务器上，AI 就可以：

- ⚙️ **执行命令** —— 远程运维、日志排查、服务管理
- 📤 **上传 / 📥 下载文件** —— 配置分发、日志拉取、大文件断点续传
- 🖥️ **多机管理** —— 项目 → 环境 → 主机三级树，一次配置处处可用

多种使用形态，按需选择：

| 形态 | 适合场景 |
|------|---------|
| **npx 一键使用**（推荐） | 一行配置接入任意 MCP 客户端，自动带起常驻服务与 Web 管理台 |
| **纯 stdio / 全局安装** | 不需要管理台的极简场景，SSH 参数直连 |
| **Windows 桌面应用**（存量） | 旧版托盘应用，已停止新功能迭代，已安装用户可继续使用 |

## ✨ 核心特性

### 连接能力

- 🔐 多种认证：密码 / 私钥（含加密私钥）/ SSH Agent / 键盘交互式 **2FA**
- 🔗 SOCKS5 与 HTTP(S) 代理，穿透跳板网络
- 🚄 双传输模式：
  - `exec` —— 每命令一通道，标准 Linux 主机
  - `shell` —— 持久会话 + 标记协议，适配**堡垒机 / 跳板机**
- ⏱️ 连接 / 命令 / SFTP 三级超时独立可控；大文件走 fastPut/fastGet 分片并发

### 安全策略

- 命令白名单 / 黑名单（正则），主机级与全局级双层过滤
- 本地与远端路径白名单，约束文件传输范围
- 全量审计日志：命令、输出、传输记录可追溯

### Web 管理台

- 项目-环境-主机三级可视化管理，连接拖拽排序
- 测试连接、JSON 批量导入导出、`~/.ssh/config` 自动复用
- 定时备份快照与一键恢复；MCP 客户端（Claude Code 等）一键注册
- 明暗双主题，跟随系统切换

### Windows 桌面应用

- 🎯 **纯托盘单 exe**：SSH 服务、MCP Server、Admin 静态站点全部内嵌，无 Node.js 依赖
- 开机自启、关机驻留；「打开管理页」直达系统默认浏览器
- 🔄 在线自更新：内置 minisign 验签，自动检测新版本静默升级

## 📸 界面一览

**连接管理** —— 三级树管理全部主机：

<div align="center"><img src="https://raw.githubusercontent.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/main/docs/screenshots/connections.png" alt="连接管理界面" width="820"></div>

## 🚀 快速开始

### 方式一：npx 一键使用（推荐）

MCP 客户端 JSON 配置（Claude Code、Cursor 等通用）：

```json
{
  "mcpServers": {
    "ssh-server": {
      "command": "npx",
      "args": ["-y", "@keysqiu/ssh-mcp-server@latest"]
    }
  }
}
```

也可命令行注册：

```bash
claude mcp add ssh-server -- npx -y @keysqiu/ssh-mcp-server@latest
```

首次调用会自动拉起常驻服务，之后：

- 🖥️ **Web 管理台**：浏览器打开 `http://127.0.0.1:61823/admin/`，可视化维护项目 → 环境 → 主机，保存即时生效，无需重启 MCP 会话
- 🔁 **常驻复用**：MCP 客户端经 stdio 自动转发到常驻服务；客户端退出后服务继续驻留，下次会话秒级复用
- 🔌 **自定义端口**：在 args 中加 `--admin-port <port>`（默认 61823）

### 方式二：高级用法（纯 stdio / 全局安装）

配置中出现 SSH 参数或 `--config-file` 时自动回到传统 stdio 模式（不拉经常驻服务）：

```json
{
  "mcpServers": {
    "ssh-server": {
      "command": "npx",
      "args": ["-y", "@keysqiu/ssh-mcp-server@latest", "--host", "your.server.com", "--username", "root", "--password", "YOUR_PWD"]
    }
  }
}
```

也可全局安装后直接使用二进制：

```bash
npm install -g @keysqiu/ssh-mcp-server
claude mcp add ssh-server -- ssh-mcp-server --host your.server.com --username root --password YOUR_PWD
```

其他开关：手动启动常驻管理台 `--admin`；强制传统 stdio `--stdio`。配置文件与多连接模式详见 [`docs/migration.md`](docs/migration.md) 与 CLI 帮助（`--help`）。

### 方式三：Windows 桌面应用（存量）

从 [Releases](https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/releases) 下载 `SSH-MCP-Server_x.x.x_x64-setup.exe` 安装。启动后驻留系统托盘，托盘菜单「打开管理页」进入 Web 控制台。该形态已停止新功能迭代，建议迁移到 npx 形态。

### 方式四：源码构建

```bash
git clone https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server.git
cd ssh-mcp-server && npm install

npm run build                 # 构建 Node 版
npm test                      # 运行测试
npm --prefix admin-web install && npm --prefix admin-web run build   # 构建管理台前端
npm run tauri:build           # 构建 Windows 桌面应用（需 Rust 工具链）
```

## 🧰 MCP 工具一览

| 工具 | 说明 |
|------|------|
| `execute-command` | 远程执行命令，支持目录切换、超时与输出限制，受白/黑名单约束 |
| `upload` / `download` | SFTP 文件传输，大文件分片并发，路径白名单校验 |
| `list-servers` | 列出所有可用连接 |

## 🏗️ 架构

```
┌─ Windows 桌面应用（Tauri 2 纯托盘单 exe）──────────────────┐
│                                                            │
│  SSH 连接池 ── MCP StreamableHTTP (/mcp)                   │
│      │                                                     │
│  Admin API (/admin/api/*) ── 内嵌静态站点 (/admin/)        │
│                                                            │
└────────────────── 系统默认浏览器打开管理页 ────────────────┘

Node 版（npm 包）：stdio MCP Server ＋ 可选 --admin 启动同一套 Web 管理台
```

关键模块：`src/services/ssh-connection-manager.ts`（SSH 核心）、`src/server/`（Fastify Admin 服务）、`src-tauri/`（Rust 桌面壳）、`admin-web/`（React 管理台）。

## 📋 更多文档

- [使用迁移指南](docs/migration.md) —— 各客户端接入配置
- [更新日志](CHANGELOG.md)

## 📄 许可证

[ISC](LICENSE) © SIE Operations and Maintenance Team
