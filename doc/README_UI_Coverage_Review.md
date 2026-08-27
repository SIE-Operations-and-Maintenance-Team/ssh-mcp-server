# README → UI 覆盖度 Review

> 目标：逐项核对 `README.md` 暴露的所有用户可配置能力，是否已在 Admin Web (`admin-web/src/pages/*.tsx`) 中提供可维护入口。
> 基准：`README.md:1-638`、`src/models/types.ts:6-34` (`SSHConfig` 25 字段)、`src/cli/command-line-parser.ts:87-118` CLI 23 选项、`src/models/admin-types.ts:3-13` (`ConnectionSchema`)。
> 审查时间：2026-08-21 轮次1

## 结论先行

| 维度 | 总数 | UI 已覆盖 | 部分覆盖 | 未覆盖 |
|------|------|-----------|----------|--------|
| CLI 选项 (23) | 23 | 7 | 2 | 14 |
| SSHConfig 字段 (25) | 25 | 5 | 2 | 18 |
| README 功能节 (§0-§10 + 超时/输出/列表/安全) | 13 | 5 | 3 | 5 |
| Admin GUI 声明页 (6页) | 6 | 4 | 2 | 0 |

**总体覆盖率约 35%**。核心链路（增删连、测连、审计、备份、黑白名单全局版、注册 MCP）已可用；**单连接高级能力大量缺口**，`ConnectionSchema` 仅 7 字段 vs `SSHConfig` 25 字段是根因。

---

## 1. CLI 选项 → UI 映射表

| CLI | 类型 | SSHConfig/含义 | UI 入口 | 状态 | 备注 |
|-----|------|----------------|---------|------|------|
| `--config-file` | string | 多连接 JSON 文件 | 无 | ❌ 未覆盖 | Connections 仅单条表单，无导入/导出/文件路径选择。`store.load/save` 已支持任意 JSON，但无文件选择器。 |
| `--ssh-config-file` | string | `~/.ssh/config` 路径 | 无 | ❌ 未覆盖 | `lookupSshConfig()` 会自动读，但 UI 未暴露路径配置也无“复用 SSH config 别名”说明。 |
| `--ssh` | string[] | 多连接 JSON/旧逗号格式 | 无 | ❌ 未覆盖 | 同上，多连接靠表格多行实现，但无批量导入。 |
| `-h/--host` | string | `host` | `Connections.tsx:76` 主机地址 | ✅ 已覆盖 | |
| `-p/--port` | string | `port` | `Connections.tsx:77` 端口 InputNumber | ✅ 已覆盖 | |
| `-u/--username` | string | `username` | `Connections.tsx:78` 用户名 | ✅ 已覆盖 | |
| `-w/--password` | string | `password` | `Connections.tsx:79` 密码 | ✅ 已覆盖 | 明文输入，无“显示/脱敏”切换，后端 `admin.ts:12` 已脱敏 `***`。 |
| `-k/--privateKey` | string | `privateKey` | 无 | ❌ 未覆盖 | `ConnectionSchema:9` 有字段但 UI 未渲染，无文件选择/路径展开提示 `~/`。 |
| `-P/--passphrase` | string | `passphrase` | 无 | ❌ 未覆盖 | 同上，密钥口令无入口。 |
| `-a/--agent` | string | `agent` | 无 | ❌ 未覆盖 | `ConnectionSchema:11` 有但 UI 未暴露，无 Pageant/`SSH_AUTH_SOCK` 自动回退说明。 |
| `--try-keyboard` | boolean | `tryKeyboard` (2FA) | 无 | ❌ 未覆盖 | `README §9` 的 2FA 核心开关，`types.ts:15` 已定义，UI 零入口。 |
| `-W/--whitelist` | string | `commandWhitelist` | `Security.tsx:80` 全局白名单 | ⚠️ 部分覆盖 | 现为**全局** `GlobalConfig.security.commandWhitelist`，而 `SSHConfig.commandWhitelist` 是**按连接**维度；UI 无法按连接配置。 |
| `-B/--blacklist` | string | `commandBlacklist` | `Security.tsx:82` 全局黑名单 | ⚠️ 部分覆盖 | 同上，按连接缺口；全局默认 7 条已落地 `admin.ts:7`。 |
| `--proxy` | string | `proxy` (socks/http/https) | 无 | ❌ 未覆盖 | `types.ts:18` 支持，UI 无代理 URL 输入。 |
| `-s/--socksProxy` | string | `socksProxy` (兼容) | 无 | ❌ 未覆盖 | 同上。 |
| `--allowed-local-paths` | string | `allowedLocalPaths` | `Security.tsx:99` 全局 | ⚠️ 部分覆盖 | 同 whitelists：全局已可存，但按连接维度缺失；且 `Security.tsx` 为逗号字符串，后端 `admin.ts:parsePaths` 已兼容。 |
| `--allowed-remote-paths` | string | `allowedRemotePaths` | `Security.tsx:100` 全局 | ⚠️ 部分覆盖 | 同上。 |
| `--transport-mode` | string | `transportMode` exec/shell | 无 | ❌ 未覆盖 | `README §8` 堡垒机核心，`types.ts:24` 已定义，UI 零入口。 |
| `--shell-ready-timeout` | string | `shellReadyTimeoutMs` | 无 | ❌ 未覆盖 | shell 模式配套，无入口。 |
| `--command-template` | string | `commandTemplate` | 无 | ❌ 未覆盖 | `README §7` 的 `su/sudo/docker/ssh jumphost` 模板，无入口。 |
| `--pty` | boolean | `pty` | 无 | ❌ 未覆盖 | `types.ts:21` 默认 true，无开关。 |
| `--pre-connect` | boolean | `preConnect` | 无 | ❌ 未覆盖 | CLI 独有，UI 无预连接切换（`ParsedArgs:99`）。 |
| `--admin/--admin-port` | boolean/string | Admin HTTP | `System.tsx:24` 仅展示 `info.port` | ⚠️ 部分覆盖 | 启动由 CLI 决定，UI 仅读 `system/info`，无端口修改/重启入口；符合“本机信任”设计，但与 `Settings` 预期不符。 |

---

## 2. SSHConfig 字段 → ConnectionSchema/UI 缺口

`src/models/types.ts:6-34` 定义 25 字段，`src/models/admin-types.ts:3-13` `ConnectionSchema` 仅暴露 7 字段：

```
ConnectionSchema 已有: name, host, port, username, password, privateKey, passphrase, agent, tryKeyboard
                    ↑ 但 UI 仅渲染 name/host/port/username/password 5 项，privateKey/passphrase/agent/tryKeyboard 4 项“有 schema 无表单”
缺失: proxy, socksProxy, algorithms, pty, allowedLocalPaths, allowedRemotePaths, transportMode,
      shellReadyTimeoutMs, shellCommandTimeoutMs, commandTimeoutMs, connectionTimeoutMs,
      sftpTimeoutMs, maxOutputBytes, keepaliveIntervalMs, keepaliveCountMax, commandTemplate,
      commandWhitelist/Blacklist (按连接)
```

影响：
- `admin.ts:17-27` `POST /admin/api/connections` 走 `ConnectionSchema.passthrough().parse → normalizeConfig`，理论上透传可存任意字段，但 UI 不采集 → 用户无法通过界面用上代理/堡垒机/超时/模板等能力，仍需手写 JSON/CLI。
- `Security.tsx` 的全局 `security` 与按连接的 `SSHConfig.commandWhitelist` 是两套语义，当前全局覆盖仅适用于“未按连接覆盖时”的兜底，易误解。

---

## 3. README 功能节覆盖

| README 节 | 核心能力 | UI 现状 | 判定 |
|-----------|----------|---------|------|
| §0 Skill | 交互式问答生成配置 | 无 | ❌ 无 GUI 向导，符合预期（Skill 归 AI 助手侧）。 |
| §1-3 账号/私钥/口令 | 基础认证三件套 | Connections 仅 password | ❌ 私钥/口令/Agent 缺表单 |
| §4 复用 `~/.ssh/config` | Host 别名 + 自定义路径 | 无 | ❌ 无路径输入、无别名解析提示 |
| §5 代理 | `proxy`/`socksProxy` 多协议 | 无 | ❌ |
| §6 白/黑名单 | 正则逗号分隔 | Security 全局版 | ⚠️ 按连接缺失 |
| §7 命令模板 | `commandTemplate` `<quotedCommand>` | 无 | ❌ |
| §8 堡垒机 shell | `transportMode` + `shellReadyTimeout` | 无 | ❌ |
| §9 2FA | `tryKeyboard` + `SSH_MCP_2FA_CODE` | 无 | ❌ |
| §10 多连接 | 数组/对象/`--ssh` 三格式 | Connections 表格多行算“阵列” | ⚠️ 无文件导入导出/JSON 粘贴 |
| ⏱️ 超时 | `commandTimeoutMs`/`shellCommandTimeoutMs`/`connectionTimeoutMs`/`sftpTimeoutMs`/`keepalive*` | 无 | ❌ 全部无入口 |
| 📦 输出限制 | `maxOutputBytes` | 无 | ❌ |
| 🗂️ list-servers | 工具侧列表 | Connections 表格即列表 | ✅ 视为覆盖 |
| 🛡️ 安全注意事项 | 路径遍历/本地/远端范围 | Security 已落实 allowed* + POSIX 提示 | ✅ 已覆盖（高危标红、自动 `^` 已实现） |
| 🖥️ Admin GUI 声明 | 6 页面 + 双传输 + 托盘 | 6 页均存在，`System` 注册、`Audit` 分页、`Backups` 快照恢复、`Settings` 占位 | ⚠️ Settings 仍为 probe 假保存（见 §4） |

---

## 4. 按页面 Detail

### Connections (`admin-web/src/pages/Connections.tsx:1-84`)
- 已有：表格 `name/host/port/username` + `Test Connection 8s` (`admin.ts:36-65`) + 删除 + 新增 Modal。
- 缺：`privateKey` 文件路径（应支持 `~/` 展开提示）、`passphrase`、`agent`、`tryKeyboard` Switch、`proxy`/`socksProxy` 输入、`transportMode` Select、`commandTemplate` 输入、`pty` Switch。
- 建议：Modal 增“高级折叠面板”，分 `认证/代理/传输/超时` 四组；已有 `store.save` 无需后端改动，仅扩展 `ConnectionSchema` 并补表单。

### Security (`admin-web/src/pages/Security.tsx:1-106`)
- 已有：全局 `whitelist/blacklist`（自动补 `^`、`validateRegex`）、`allowedLocalPaths/RemotePaths`、`GET/POST /admin/api/security` 完整落盘（`admin.ts:7-38`）、高危标红 `Tag color="error"` + 预览、主题跟随。
- 缺：按连接维度（若保留全局语义需在页内注明“全局兜底，连接级可在 Connections 高级里覆盖”）。

### Audit (`admin-web/src/pages/Audit.tsx:1-23`)
- 已有：`GET /admin/api/audit?page&pageSize&q` 分页 + 搜索 + 状态 Tag。
- 缺：README 未要求更多，满足 P1。后续可加时间范围/导出。

### Backups (`admin-web/src/pages/Backups.tsx:1-21`)
- 已有：`GET /admin/api/backups` 列表、`POST /snapshot`、`POST /restore/:id`（恢复前自动快照在 `src/server/routes/backups.ts:7-9` 侧）。
- 满足 README 描述。

### Settings (`admin-web/src/pages/Settings.tsx:1-22`)
- 现状：仅 `auditRetention/backupRetention` 两个 `InputNumber`，`save()` 为 **假保存**：`fetch POST /admin/api/connections {name:"__settings_probe"}` 并 `message.success(JSON.stringify(v))`，未落盘到 `GlobalConfig.audit/backups`。
- 缺：`GlobalConfigSchema:18-30` 的 `audit.enabled/logResults/retentionDays`、`backups.retentionDays/maxCount`、`port/adminPort`、`preConnect`、`pty` 默认等均无真实 API (`admin.ts` 无 `/admin/api/settings` 或 `/admin/api/config`)。
- 建议：新增 `GET/POST /admin/api/settings` 读写 `GlobalConfig.audit/backups/port`，Settings 页改为真实表单。

### System (`admin-web/src/pages/System.tsx:1-39`)
- 已有：`GET /admin/api/system/info` (`port/version/platform`)、`POST /admin/api/system/register-mcp` (`client/scope/serverName/port/force/conflict` 检测)。
- 缺口小：符合 README `一键注册 MCP 到 Muse/VS Code` 描述；可增 `pre-connect` 状态展示与日志尾。

---

## 5. 优先级建议（不属本次 Review 范围，仅供下一步决策）

- **P0（阻塞“README 能力 UI 可维护”承诺）**：Connections 高级面板补 `privateKey/passphrase/agent/tryKeyboard/proxy/transportMode/commandTemplate/pty` + `Settings` 真实落盘。
- **P1（README 显式强调）**：超时四件套 `commandTimeoutMs/shellCommandTimeoutMs/connectionTimeoutMs/sftpTimeoutMs` + `maxOutputBytes` + `keepalive*` + `allowedLocal/RemotePaths` 按连接覆盖。
- **P2（体验）**：`--config-file` 导入导出、`--ssh-config-file` 路径、`--ssh` JSON 粘贴、多连接批量操作。

---

## 6. 证据索引

- README 基准：`README.md:579-609` CLI 参考、`README.md:30-38` 功能亮点、`README.md:613-622` Admin GUI 声明
- 类型基准：`src/models/types.ts:6-34`、`src/models/admin-types.ts:3-13`、`src/services/config-store.ts:6-11`
- UI 现状：`admin-web/src/pages/Connections.tsx:74-80`、`admin-web/src/pages/Security.tsx:80-101`、`admin-web/src/pages/Settings.tsx:6-7`、`admin-web/src/pages/System.tsx:10-13`
- 服务端：`src/server/routes/admin.ts:6-66`、`src/server/routes/system.ts:8-17`、`src/cli/command-line-parser.ts:87-118`

> 判定口径：**有表单 + 有 API 落盘 + 有回显** 算“已覆盖”；仅有 schema/透传但无表单算“未覆盖”；全局有但按连接无算“部分覆盖”。
