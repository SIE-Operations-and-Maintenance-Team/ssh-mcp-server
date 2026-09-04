# Changelog

## v1.1.1

### 修复

- **连接管理页移除「复用 ~/.ssh/config」提示横幅**：主机地址占位文案同步精简；Host 别名解析能力后端保留不受影响
- **暗黑模式滚动条白底优化**：滚动条样式由仅 `html` 扩展为全局所有滚动容器，轨道透明、滑块按主题着色（暗黑为半透明白），并通过 `color-scheme`/`data-theme` 与主题切换即时联动

**对比 v1.1.0**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.1.0...v1.1.1

## v1.1.0

本版本起全面转向 npx 分发形态：`npx -y @keysqiu/ssh-mcp-server@latest` 一行配置即可使用，首次调用自动拉起常驻服务，Web 管理台与 MCP 通道同进程共享配置、改动即时生效；包名由 `@sieop/ssh-mcp-server` 迁移至 `@keysqiu/ssh-mcp-server` 并首次发布 npm。桌面应用停止新功能迭代，存量用户可继续使用。

### 功能

- **npx 代理模式（新默认）**：无参数运行时自动探测/分离拉起 admin 常驻服务（端口优先级 `--admin-port > 配置文件 > 61823`，就绪等待 15s），本进程仅做 stdio→HTTP 转发（兼容 JSON 与 SSE 响应）；MCP 客户端退出后常驻服务继续驻留，下次会话秒级复用；常驻服务日志落 config 同目录 `daemon.log`
- **配置热生效**：管理台增删改主机经已有 watcher 同步至常驻服务的连接管理器，MCP 工具调用即时可用新配置，无需重启会话
- **兼容开关**：`--stdio` 强制传统 stdio 模式；配置中出现任何 SSH 参数（`--host`/`--config-file`/`--ssh` 等）时自动回退传统模式；`--admin` 手动常驻模式不变
- **审计持久化（npm 形态）**：`better-sqlite3` 纳入运行时依赖，npx/CLI 形态审计记录落 `~/.config/ssh-mcp-server/audit.db`，重启不再丢失（与桌面版对齐）

### 修复

- **移除 Web 管理台「系统」菜单**：系统页（自启动/应用更新/应用控制/一键注册）随 npx 形态下语义失效一并移除，界面仅保留连接管理/安全策略/审计日志/备份恢复/设置；对应后端接口暂保留未删

**对比 v1.0.5**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.5...v1.1.0

## v1.0.5

修复 PublishTools 同步导入后主机名称显示为空、编辑保存变成新增两个问题（同根因：桌面版导入未回填主机对象 name 字段）；启动时自动迁移治愈存量脏数据。

### 修复

- **导入回填主机名称（桌面版）**：`config_import` projects 分支导入时把 hosts map 的 key 回填到主机对象 `name` 字段（对齐 Node 版行为）；此前源数据对象内无 name 时静默存为空串，导致列表名称列空白、编辑不改名保存报「主机已存在」、改名保存变成新增且残留旧记录
- **存量数据迁移（桌面版）**：启动时自动检测并回填 name 为空的主机（写前生成 .bak 备份，数据干净时不写盘）；读取路径同步归一化兜底
- **导入解析容错（桌面版）**：项目 JSON 解析失败改为记 warning 跳过，不再静默清空整个项目；key 空白的主机跳过并告警
- **Node 版读取兜底**：`load()` 在 Zod 校验前归一化主机名，修复 Node 版读取桌面版导入的脏配置时整个 load 抛错的问题（ConnectionSchema.name 有 min(1) 约束）
- **前端展示兜底**：主机列表对象内 name 为空时用 map key 补齐，展示与编辑标识一致

**对比 v1.0.4**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.4...v1.0.5

## v1.0.4

v1.0.3 标签推送后发布流水线未产出安装包（未生成 Release），本版本重新发布同一批修复，审计日志持久化正式交付；另附升级后审计丢失问题的根因诊断文档。

### 功能

- **审计日志持久化（桌面版）**：审计记录写入 `%ProgramData%\SshMcpServer\audit.db`（与 config.json 同目录，NSIS 升级保留），表结构与查询语义对齐 Node 版，新增 `ts` 索引；此前为内存 RingBuffer（上限 5000 条），任何进程重启（升级/托盘重启服务/崩溃/关机）都会清空全部审计记录
- **保留天数生效（桌面版）**：设置页「审计保留天数」现于每次写入时清理过期记录，与 Node 版行为一致

### 修复

- 

**对比 v1.0.3**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.3...v1.0.4

## v1.0.3

修复桌面版审计日志随进程重启丢失的问题：审计记录落盘 SQLite，升级/重启不再清空。

### 功能

- **审计日志持久化（桌面版）**：审计记录写入 `%ProgramData%\SshMcpServer\audit.db`（与 config.json 同目录，NSIS 升级保留），表结构与查询语义对齐 Node 版，新增 `ts` 索引；此前为内存 RingBuffer（上限 5000 条），任何进程重启（升级/托盘重启服务/崩溃/关机）都会清空全部审计记录
- **保留天数生效（桌面版）**：设置页「审计保留天数」现于每次写入时清理过期记录，与 Node 版行为一致

### 修复

- 

**对比 v1.0.2**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.2...v1.0.3

## v1.0.2

管理台体验增强：尚无主机的项目在连接管理列表中带醒目状态标识，避免"建了项目却找不到"的困惑。

### 功能

- **空项目状态标识**：连接管理项目列表中，主机数为 0 的项目描述行追加橙色「未配置主机」标签（Node 版与桌面版共用同一前端，同步生效），一眼区分"已就绪"与"待配置"的项目

### 修复

- 

**对比 v1.0.1**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.1...v1.0.2

## v1.0.1

管理与桌面端体验修复：审计日志可预览执行明细，桌面版定时备份补齐调度与清理，暗黑模式三处显示修复。

### 功能

- **审计明细与预览**：审计日志现记录命令/路径明细（命令含工作目录前缀，传输记源→目标路径），列表新增「命令 / 路径」列，支持弹窗查看单条详情，搜索可按命令内容命中（Node 与桌面版双端同步）
- **定时备份（桌面版）**：Tauri GUI 内置备份调度——启动时按保留策略清理一次历史积压，之后按设定间隔自动快照并执行清理，与 Node 版语义一致
- **设置开关更名**：「记录执行结果」更名「记录成功执行」并补充说明（关闭后仅记录失败操作），消除语义歧义

### 修复

- **暗黑模式**：修复连接管理（项目选中项）、安全策略（黑名单输入框）、系统（信息卡片）三处硬编码浅色背景导致文字不可读的问题
- **备份时间显示**：修复 Windows 下文件复制保留源 mtime 导致所有备份显示同一时间的问题，备份时间改以文件名内嵌时间戳为准
- **备份清理**：修复「最大备份数量」「保留天数」在桌面版不生效的问题（此前桌面版无清理逻辑，备份目录无限增长）

**对比 v1.0.0**：https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server/compare/v1.0.0...v1.0.1

## v1.0.0

首个正式版本。SSH-based MCP Server——让 MCP 客户端（Claude Code、Cursor 等）通过标准化工具在远端执行命令与传输文件，内置 Web 管理台与 Windows 托盘应用。

### 功能

- **MCP 工具**：`execute-command` / `upload` / `download` / `list-servers`，支持多连接、白/黑名单校验、输出限制与结构化错误
- **连接能力**：密码 / 私钥 / Agent / 2FA 认证，SOCKS5 与 HTTP(S) 代理，exec / shell 双传输模式（shell 模式适配堡垒机/跳板机）
- **Admin 管理台**：项目-环境-主机三级树管理连接；安全策略、审计日志、配置备份/恢复、定时快照、MCP 客户端一键注册
- **Windows 桌面应用**：Tauri 2 纯托盘单 exe——SSH 连接池 / MCP StreamableHTTP / Admin 静态站点全部内嵌；「打开管理页」在系统默认浏览器中打开；托盘菜单含关于（版本+服务地址）/ 重启服务 / 退出，双击图标直接打开管理页
- **在线自更新**：应用内置 minisign 验签，自动拉取 GitHub Releases 的 latest.json 完成静默升级；Node 版支持 npm registry 版本检查
