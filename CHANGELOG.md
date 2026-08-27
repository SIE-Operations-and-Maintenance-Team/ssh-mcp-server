# Changelog

## v1.0.0

首个正式版本。SSH-based MCP Server——让 MCP 客户端（Claude Code、Cursor 等）通过标准化工具在远端执行命令与传输文件，内置 Web 管理台与 Windows 托盘应用。

### 功能

- **MCP 工具**：`execute-command` / `upload` / `download` / `list-servers`，支持多连接、白/黑名单校验、输出限制与结构化错误
- **连接能力**：密码 / 私钥 / Agent / 2FA 认证，SOCKS5 与 HTTP(S) 代理，exec / shell 双传输模式（shell 模式适配堡垒机/跳板机）
- **Admin 管理台**：项目-环境-主机三级树管理连接；安全策略、审计日志、配置备份/恢复、定时快照、MCP 客户端一键注册
- **Windows 桌面应用**：Tauri 2 纯托盘单 exe——SSH 连接池 / MCP StreamableHTTP / Admin 静态站点全部内嵌；「打开管理页」在系统默认浏览器中打开；托盘菜单含关于（版本+服务地址）/ 重启服务 / 退出，双击图标直接打开管理页
- **在线自更新**：应用内置 minisign 验签，自动拉取 GitHub Releases 的 latest.json 完成静默升级；Node 版支持 npm registry 版本检查
