# Bug 诊断报告：暗黑模式页面变白 / 审计无执行结果预览 / 定时备份时间与清理异常

- **日期**：2026-08-30
- **状态**：已修复（同日完成，修复验证见文末）
- **严重级别**：P2 一般（UI 可用性 2 项 + 备份可靠性 1 项）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）
- **运行时**：用户正在运行 **Tauri 托盘版** `ssh-mcp-server-gui.exe`（PID 44204，路径 `E:\software\SSH Server\`），管理页 61823 端口，内嵌前端为编译期 `include_dir!` 打包的 admin-web/dist

---

## 问题描述

1. 暗黑模式下，「连接管理」「安全策略」「系统」页面存在整块变白、内容看不清的区域。
2. 设置页有「记录执行结果」开关，但审计日志页找不到任何"预览/查看内容"功能。
3. 设置了每小时自动备份、最大备份数量 10，但：
   - 备份列表里时间全是同一批相同值（如 2026/8/26 11:10:00）；
   - 超过 10 份的旧备份没有被删除（当前 backups 目录有 **68 个文件**）。

---

## 问题 1：暗黑模式整块变白（已截图确认）

### 根因

页面内**硬编码浅色背景**未跟随主题算法。AntD darkAlgorithm 下文字变为浅色，落在硬编码的浅色背景上即不可读。三处全部定位：

| 页面 | 位置 | 硬编码 | 现象（截图确认为证） |
|---|---|---|---|
| 连接管理 | `admin-web/src/pages/Connections.tsx:571` | `background: isActive ? "#e6f4ff"` + 边框 `#91caff` | 左侧项目列表选中项变亮蓝底，白字不可读 |
| 安全策略 | `admin-web/src/pages/Security.tsx:80` | `background:"#fff1f0"`、`borderColor:"#ff4d4f"` | 黑名单 TextArea 整块亮粉底，占位符/文字不可读 |
| 系统 | `admin-web/src/pages/System.tsx:108` | `background:"linear-gradient(135deg,#f0f7ff 0%,#ffffff 100%)"` | 顶部信息卡整块白底，服务端口/版本号/运行平台白字完全看不见 |

截图：`doc/screenshots/dark-{connections,security,system,audit}.png`。

### 修复建议

统一改用 AntD 语义 token 而非写死色值，例如：
- 选中项：`token.colorPrimaryBg` / `colorPrimaryBorder`（或 `isDark` 三目）；
- 黑名单框：保留红色描边示意，但背景改为 `colorErrorBg`（暗色下为暗红）；
- 系统信息卡：渐变改为 `token.colorPrimaryBg`→`token.colorBgContainer`，或暗色下直接用 `colorBgContainer`。

---

## 问题 2：「记录执行结果」开关与审计预览（确认为功能缺口，非配置问题）

### 根因：审计链路根本不存储命令内容/执行输出，预览无从谈起

调用链（已逐行核实）：

```
执行命令
  → SshConnectionManager.auditLog(connection, tool, ok)   [src/services/ssh-connection-manager.ts:293]
      只传 { connection, tool, status }，无命令文本、无输出
  → AuditStore.log()                                       [src/services/audit-store.ts]
      表结构含 sql 列（CREATE TABLE ... sql TEXT），但从未写入 → 恒为 ""
  → GET /admin/api/audit                                   [src/server/routes/audit.ts]
  → Audit.tsx 表格只有 时间/连接/工具/状态 四列             [admin-web/src/pages/Audit.tsx:26]
```

关键事实：
- `audit-store.ts` 的 `AuditEntry` 已预留 `sql?: string` 字段、SQLite 表也有 `sql` 列，但 `auditLog()` 调用点（4 处，均在 ssh-connection-manager.ts）从不传命令文本——**数据在源头就丢了**。
- 设置页 `auditLogResults` 开关（`Settings.tsx:101`）的真实语义是 **"成功执行是否也记入审计"**（`auditLog` 中 `if (ok && audit?.logResults === false) return;`，失败始终记录），与"记录执行结果（输出内容）"字面含义完全不符，且开关无 extra 说明文案——这是用户困惑的直接来源。
- 审计页无详情列、无行展开、无 Modal 预览（`Audit.tsx:26` 仅 4 列）。

### 修复建议（需产品决策，二选一或组合）

1. **对齐字面语义**：`auditLog()` 增加 `sql`（命令文本）参数并在各调用点传入；审计页加"命令"列 + 行展开/详情 Modal 预览。是否记录输出需慎重（输出可能含敏感信息，且会放大 SQLite 体积），建议仅记命令文本 + 截断预览。
2. **改开关文案**：若不打算存内容，把「记录执行结果」改为「记录成功执行」（extra："关闭后仅记录失败操作"），消除歧义。

---

## 问题 3：定时备份三连问（每小时未执行感 / 时间全同 / maxCount 不生效）

### 运行时事实（实测）

- 备份目录 `C:\ProgramData\SshMcpServer\backups` 现有 **68 个文件**（maxCount=10 未生效）。
- `/admin/api/backups` 返回的所有条目 `ts` 全部等于 `1787713800930`（= 2026-08-26 11:10:00.930 本地，与用户描述完全一致）。
- 文件名序列 `config-2026-08-26T20-50-50…23-50-50、08-27T00-50-51…` 证明**历史上确实存在按小时执行的任务**（Node 版调度器所为，节奏为每小时 ：50:50）；但**当前运行的 Tauri GUI（Rust）没有任何定时备份代码**，8/27 之后备份已停止。

### 根因 1：时间全部相同 —— Windows 下 `copyFile` 保留源文件 mtime

- Node `BackupService.list()` 用 `stat.mtimeMs` 作为展示时间（`src/services/backup-service.ts:63`）；Rust `backups_list` 用 `metadata().modified()`（`src-tauri/src/admin_http.rs:646`）。
- 而备份是 `fs.copyFile`（Node）/ `std::fs::copy`（Rust，走 `CopyFileW`）从 config.json 复制而来——**Windows 上复制出的文件 mtime = 源文件（config.json）的最后修改时间，不是备份创建时间**。
- 实测复现：`fs.copyFileSync(config.json)` 后副本 mtime 与源完全一致（2026-08-30T00:24:19.689Z）。
- 因此：config.json 自 8/26 11:10 后未再修改前，期间每小时生成的所有备份文件 mtime 全是 8/26 11:10 —— 用户看到"一批时间全一样"。
- **修复**：创建备份后显式 `fs.utimes(dst, now, now)`（Rust 端用 `filetime` crate 或等价 API）重置 mtime；更稳的做法是 `list()` 解析**文件名内嵌时间戳**作为 `ts`（文件名本来就有毫秒级 UTC 时间），彻底摆脱文件系统时间语义。

### 根因 2：maxCount/retentionDays 不生效 —— 当前运行的 Tauri 端根本没有 prune 与调度器

- 全量检索 `src-tauri/src`：`auto_enabled`/`max_count`/`interval_hours` 仅作为配置字段读写保存（`admin_http.rs:561-569`、`config.rs:130-134`），**无任何定时任务、无任何删除旧备份的逻辑**。`backups_snapshot`（`admin_http.rs:661`）与 `do_snapshot_internal`（`admin_http.rs:697`）均不调用 prune。
- Node 端实现是完整的（`backup-scheduler.ts` 调度 + `backup-service.ts` `prune()` 按 retentionDays → maxCount 两段清理，snapshot 内也自清），但只在 Node 运行模式（`node build/index.js --admin`）下生效；Tauri GUI 是纯 Rust 进程，Node 代码完全不在运行。
- 现存的 68 个文件（含 8/25 大量毫秒级连发的文件）就是 Tauri 版从不清理的证据；Node 版历史上的每小时备份是用户此前跑 Node 服务时产生的。
- **修复**（建议对齐 Node 语义在 Rust 端补齐）：
  1. `backups_snapshot` / `do_snapshot_internal` 完成后执行 prune（按 retentionDays 过期 + 按 maxCount 截断，注意先按文件名时间降序再 `slice(maxCount)`，与 Node `BackupService.prune` 一致）；
  2. 新增 tokio 后台任务：`tokio::spawn` + `tokio::time::interval`（或 sleep 循环）按 `interval_hours` 触发 snapshot+prune，读取配置并响应配置变更（监听配置重载信号重置 interval）；
  3. 或者：GUI 启动时以 sidecar 方式托管 Node 服务，复用现有 Node 调度（架构权衡，改动更大，不推荐）。

### 根因 3（认知偏差澄清）："没有按预期每小时执行" 一半是错觉

- 历史文件名证明 Node 版调度器确实按小时执行了（:50:50 节奏）；
- 用户看到"没执行"是因为展示时间全部相同（根因 1），无法分辨新旧；
- 而切换到 Tauri GUI 后（8/27 之后）定时备份**确实彻底停了**（根因 2），用户的感受在后半段是真实的。

---

## 边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 建议 |
|---|---|---|---|---|
| 数据边界 | 备份目录 >10 份时切到 Tauri | 永不清理，无限增长 | 是 | Tauri 端补 prune，首次启动时先清一次历史积压 |
| 时间语义 | config.json 长期未改 | 所有新备份展示时间相同 | 是 | ts 取文件名时间戳 |
| 并发 | Node 与 Tauri 先后运行指向同一备份目录 | 两套命名/清理规则混跑 | 是（现状即混跑产物） | 统一由当前运行时负责清理 |
| 空值 | `intervalHours` 未配置 | Node 默认 24h；Rust 无默认 | Tauri 端无调度，无影响 | Rust 补调度时同样默认 24 |
| 主题 | `system` 模式跟随系统切深色 | 三处硬编码浅色不随动 | 是 | 用语义 token |
| 审计 | `logResults=false` 时成功不记录 | 表现正常但文案误导 | 是 | 改文案或补功能 |

## 总结与建议

三个问题的根因都已实锤：**① 三处前端硬编码浅色背景未适配暗色算法；② 审计从源头就没存命令/结果内容，预览功能属于缺口，且开关文案与实际语义不符；③ 时间全同源于 Windows copyFile 保留源 mtime，而 maxCount 不生效与"每小时没执行"源于用户当前运行的 Tauri GUI 压根没有备份调度与清理代码（Node 端实现完整但未运行）。**

建议修复顺序：3（备份可靠性，Rust 端补调度+prune+ts 取文件名）→ 1（暗色三处，改动小收益直接）→ 2（需先决策"存命令文本"与否，再动 schema 与 UI）。

---

## 修复记录（2026-08-30 当日完成）

| 问题 | 修复内容 | 涉及文件 | 验证 |
|---|---|---|---|
| ① 暗黑模式变白 | 三处硬编码颜色改为 AntD 语义 token（`theme.useToken()`：`colorPrimaryBg/colorPrimaryBorder/colorError/colorErrorBg/colorBgContainer/colorTextSecondary`） | `admin-web/src/pages/Connections.tsx`、`Security.tsx`、`System.tsx` | 暗色截图复核通过（`doc/screenshots/fix-dark-{connections,security,system}.png`） |
| ② 审计无预览 | Node：`auditLog()` 增加 `detail` 参数写入 `sql` 字段，8 个调用点分别传命令/路径（含 `cd <dir> &&` 前缀、`本地 → 远端` 方向）；Rust：`AuditEntry` 增加 `sql` 字段、`audit::log` 增加 `detail` 参数、搜索命中命令内容，5 个工具调用点传入；前端：审计列表新增"命令 / 路径"列 + 行点击/详情按钮弹窗预览；设置页开关更名「记录成功执行」并补说明文案 | `src/services/ssh-connection-manager.ts`、`src-tauri/src/audit.rs`、`src-tauri/src/mcp/handler.rs`、`admin-web/src/pages/Audit.tsx`、`Settings.tsx` | store 层单测断言 sql 往返与按命令搜索；UI mock 截图验证列表列与详情弹窗（`fix-audit-{list,detail}.png`） |
| ③ 备份时间全同 / maxCount 不生效 / 调度缺失 | Node：`list()` 优先解析文件名内嵌 UTC 时间戳（非标准命名回退 mtime）、`snapshot()` 复制后 `utimes` 重置 mtime；Rust：新增 `src-tauri/src/backup.rs` 模块——`ts_from_name`/`list_files`/`do_snapshot`/`prune`（retentionDays 过期 + maxCount 截断，对齐 Node 语义）/`spawn_scheduler`（启动先清一次历史积压，之后每 10 分钟检查、达到 interval_hours 即快照+清理），`admin_http.rs` 备份路由改为委托 backup.rs 并删除重复的时间工具函数，`manager::init` 启动调度 | `src/services/backup-service.ts`、`src-tauri/src/backup.rs`（新增）、`src-tauri/src/admin_http.rs`、`src-tauri/src/mcp/manager.rs`、`src-tauri/src/lib.rs` | Node：`/admin/api/backups` 实测各条目 ts 已按文件名时间区分；Rust：`cargo check` 通过、`cargo test --lib` 3 用例通过；Node 单测新增文件名时间戳解析与 maxCount 清理 2 个用例，全量 237 通过 |

### 修复后用户侧生效方式

Tauri GUI 的前端与备份逻辑均编译进 exe，需要重新构建并替换 GUI 程序（`npx tauri build`，产物在 `src-tauri/target/release/bundle/`）。新版 GUI 首次启动会按当前保留策略（retentionDays=7、maxCount=10）先清一次历史积压（现存 68 份 → 清理至 ≤10 份），之后按 intervalHours=1 自动快照。若暂不更新 GUI，也可临时用 Node 模式（`node build/index.js --admin`）获得同样的定时备份与清理能力。
