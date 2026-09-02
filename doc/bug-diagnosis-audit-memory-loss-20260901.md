# Bug 诊断报告：升级 v1.0.2 后审计日志全部消失

- **日期**：2026-09-01
- **现象**：用户将桌面版从 v1.0.1 升级到 v1.0.2 后，管理页「审计日志」里的历史记录全部消失
- **影响范围**：仅 **Windows 桌面版（Tauri，ssh-mcp-server-gui.exe）**；Node 版不受影响
- **数据可恢复性**：桌面版内存中的记录**无法找回**；Node 版时期的 `audit.db` 仍在本机（见 §4）

## 1. 结论（一句话）

**桌面版的审计日志从 v1.0.0 起就只存在进程内存里（RingBuffer，上限 5000 条），从未落盘**。v1.0.2 的 Tauri updater 静默安装必然退出并重启应用进程，内存随进程清零——升级只是"重启"的一种，任何重启（升级、托盘「重启服务」、崩溃、关机）都会清空审计记录。这不是 v1.0.2 引入的回归。

## 2. 证据链

1. **存储实现**（`src-tauri/src/audit.rs` 文件头注释 + 实现）：
   ```rust
   //! 内存审计日志（桌面壳简化版：RingBuffer 上限 5000 条；
   //! SQLite 持久化为后续迭代项，API 形状与 Node 版 query 一致）。
   static AUDIT: Mutex<Vec<AuditEntry>> = Mutex::new(Vec::new());
   ```
   无任何写盘路径；`log()` 只 push 内存 Vec。
2. **数据源链路**：管理页 Audit.tsx → `GET /admin/api/audit` → Rust `audit_query` → 上述内存 Vec。桌面版管理页读的就是内存。
3. **对比：Node 版有持久化**（`src/services/audit-store.ts`）：SQLite 落盘 `~/.config/ssh-mcp-server/audit.db`（Windows 实际路径 `C:\Users\<user>\.config\ssh-mcp-server\audit.db`）。
4. **升级必然重启进程**：`src-tauri/tauri.conf.json` 配置了 updater（endpoint 指向本仓库 GitHub Release 的 `latest.json`），静默安装流程 = 退出进程 → NSIS 安装 → 重启。
5. **排除版本回归**：v1.0.1 → v1.0.2 的 diff 仅 `admin-web/src/pages/Connections.tsx`（空项目标签）+ 5 个版本号文件 + CHANGELOG；审计实现零改动。v1.0.0 起行为即如此。

## 3. 概率排序复盘（诊断时）

| # | 假设 | 验证结果 |
|---|---|---|
| 1 | 升级删除了审计数据文件 | ❌ 桌面版根本没有审计文件 |
| 2 | v1.0.2 改坏了审计 schema/读取 | ❌ diff 不含审计代码 |
| 3 | retentionDays=30 清理误删 | ❌ 桌面版无清理逻辑（未持久化，无从清理） |
| 4 | **桌面版审计仅内存，重启即清** | ✅ **命中**（代码注释自证） |

## 4. 数据找回

- **桌面版内存记录**：不可恢复（进程已终止，内存已释放）。
- **Node 版时期记录**：`C:\Users\Keysqiu\.config\ssh-mcp-server\audit.db`（12 KB，最后写入 2026-08-21）仍在本机——如果需要翻 8 月 21 日之前的操作审计，这部分还在（SQLite，`audit` 表）。注意：这份库属于 Node 版服务，桌面版不会读它。

## 5. 边缘情况

- 即便不升级，桌面版审计上限 5000 条（RingBuffer 淘汰最旧），长会话同样会"丢旧"。
- 托盘菜单的「重启服务」、应用崩溃、Windows 关机，效果等同升级——都会清零。
- Node 版 `--admin` 模式与桌面版**不共库**：即使未来桌面版落盘，也需注意两版审计库路径/合并策略。

## 6. 修复建议（待决策）

| 方案 | 内容 | 成本 |
|---|---|---|
| **A（推荐）** | 桌面版审计 SQLite 持久化：落盘到 `ProgramData\SshMcpServer\audit.db`（与 config.json 同目录，随 NSIS 升级保留），启动时打开、`log()` 同步写、`query()` 改查库；对齐 Node 版表结构 | 中（一个 Rust 迭代项，原注释已计划） |
| B（过渡兜底） | RingBuffer 增量 flush 为 JSONL 文件，启动时回放 | 低，但并发写/压缩/查询能力弱于 A |
| C（临时缓解） | 审计页 UI 增加提示"桌面版审计仅内存保留，重启清空" | 极低，治标 |

建议直接做 A，做完后本问题永久消失，且与 Node 版语义对齐（CHANGELOG v1.0.1 里"双端同步"的承诺才真正成立）。
