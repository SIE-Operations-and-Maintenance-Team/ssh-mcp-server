# 迁移指南 — 从 mcp.json args 到 GUI 全局配置

本项目 P1 起新增常驻 Fastify Admin (`--admin`) 与全局 `config.json`，旧的 `mcp.json` args 仍零回归可用，但推荐迁移到可视化配置以获得审计/备份/一键注册能力。

## 旧方式（mcp.json args / --ssh / --config-file）

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": ["-y", "@keysqiu/ssh-mcp-server", "--host", "1.1.1.1", "--username", "root", "--password", "x"]
    }
  }
}
```

## 新方式（全局 config.json + --admin）

全局路径：
- Windows: `%ProgramData%\SshMcpServer\config.json`
- macOS/Linux: `~/.config/ssh-mcp-server/config.json` (`$XDG_CONFIG_HOME` 优先)
- 覆盖链：`--config-file` > `SSH_MCP_CONFIG` env > 全局路径

```json
{
  "port": 61823,
  "connections": {
    "dev": { "name": "dev", "host": "1.1.1.1", "port": 22, "username": "root", "password": "x" }
  },
  "audit": { "enabled": true, "retentionDays": 30 },
  "backups": { "retentionDays": 30 }
}
```

启动：

```bash
npx @keysqiu/ssh-mcp-server --admin --admin-port 61823
# 浏览器打开 http://127.0.0.1:61823/admin/
```

或使用 Tauri 桌面壳：`npm run build:tauri` 后安装 `src-tauri/target/release/bundle/` 产物，托盘常驻、可自启与自动更新。

## 迁移步骤

1. 导出旧 `mcp.json` 中的连接参数（`--host/--username/--ssh/--config-file` 指向的 JSON），
2. 在 GUI `Connections` 页新增同名连接（或直接编辑全局 `config.json` 的 `connections`），字段完全兼容 `SSHConfig` 全 25 字段（host/port/username/password/privateKey/passphrase/agent/tryKeyboard/proxy/socksProxy/pty/transportMode/shell*Timeout/commandTemplate/allowed*Paths/commandWhitelistBlacklist/algorithms 等），高级可在折叠面板配置并支持导入/导出 JSON，
3. `Test Connection` 验证可达后，`System` 页一键 `注册 MCP` 到目标 scope（Muse `~/.claude.json` / VS Code `~/.vscode/mcp.json`），`--admin-port` 与 `--port` 可共存（前者是 Admin HTTP，后者是 SSH 远端端口），
4. 旧 `mcp.json` 可删除或保留，`--admin` 与 `stdio` 单进程不双传，保留零回归。

## 注意事项

- 监听仅 `127.0.0.1`，本机信任无鉴权，勿暴露到公网
- 默认端口 `61823`，优先级 `CLI --admin-port > config.json:port > 61823`
- `POST /admin/api/connections` 经 `CommandLineParser.normalizeConfig` 归一化，保证 `~/key` 展开与 POSIX 校验与 CLI 一致；错误返回 400 `INVALID_CONNECTION`
- 审计默认落盘 `~/.config/ssh-mcp-server/audit.db`（`better-sqlite3` 可选，未安装时走内存），备份目录 `.../backups/`，恢复前自动快照当前
- `GET /admin/api/config/export`（仅 127.0.0.1）返回未脱敏全量用于导入导出，避免 `***` 丢密钥；`POST /admin/api/config/import` 批量导入
- 安全策略正则自动补 `^`，远端路径仅接受绝对 POSIX；全局兜底可被连接级覆盖
- `docs/` 目录被 `.gitignore` 忽略，需 `git add -f docs/migration.md`
