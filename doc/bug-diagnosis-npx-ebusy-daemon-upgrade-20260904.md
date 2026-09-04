# Bug 诊断报告：npx 升级重装时 EBUSY，常驻服务重启失败

- **日期**：2026-09-04
- **状态**：已修复（v1.1.2）
- **严重级别**：P1 严重（发版后所有 npx 用户升级必现，MCP 连接直接失败）
- **报告人**：Claude Agent（Bug Diagnosis Skill）

---

## 问题描述

用户通过 McpDog 以 `npx -y @keysqiu/ssh-mcp-server@latest` 挂载本地 MCP。重启 ssh-server 服务后报错：

1. `Process exited with code null, signal SIGKILL`（crash count: 2）
2. `npm error EBUSY: resource busy or locked, rename '...\_npx\42a2b2237264c929\node_modules\@keysqiu\ssh-mcp-server\build' -> '...\node_modules\@keysqiu\.ssh-mcp-server-Xww7OJ8F\build'`
3. `Connection failed: Process exited`，McpDog 不再重连

## 环境信息

- 版本：缓存中 1.1.0 → 触发升级 1.1.1（发布于同日）
- 平台：Windows 10/11（WebView/McpDog 拉起 npx），npx 缓存 `D:\develop\environment\nodejs\node_cache\_npx\42a2b2237264c929`
- 复现步骤：npx 缓存已有旧版本 → 常驻 daemon 存活 → npm 发布新版本 → MCP 客户端重启会话 → npx 检测到 @latest 变化触发重装 → 100% EBUSY

---

## 可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | 常驻 daemon 进程 CWD 位于 npx 缓存包目录内，Windows 下进程 CWD 所在目录不可重命名，npm 重装 rename 失败 | 高 | `stdio-proxy.ts:139` 明确写了 `cwd: path.dirname(script)`；EBUSY 的目标路径恰为 `build` 目录 |
| 2 | daemon 已加载模块/静态资源持有包内文件句柄 | 低 | Node 读入脚本后即关闭句柄；admin 静态文件按需开关；better-sqlite3 的 `.node` 虽常驻锁定但位于 `_npx\<hash>\node_modules\better-sqlite3`，不在被 rename 的 `@keysqiu/ssh-mcp-server/build` 内 |
| 3 | 两次重启并发跑 npm install 互锁 | 低 | crash count 2 表明重启了两次，但 EBUSY 路径指向包目录本身而非并发临时目录 |
| 4 | 杀毒/索引服务锁文件 | 低 | 错误路径精确指向 daemon 的 CWD，非随机文件 |

## 验证动作（已执行）

- **进程核查**：`Get-CimInstance Win32_Process` 发现三进程并存——
  - PID 7732：1.1.0 daemon `build\index.js --admin --admin-port 61823`（分离常驻，客户端重启后按设计存活）
  - PID 49752：卡住的 `npx -y @keysqiu/ssh-mcp-server@latest`（npm rename 被锁）
  - PID 60620：更早残留的代理进程
- **缓存核查**：`@keysqiu/ssh-mcp-server` 目录处于半安装损坏态（`package.json` 丢失）
- **结论**：原因 1 坐实，其余排除。

## 调用链与依赖分析

```
McpDog 重启会话
  → SIGKILL 旧 npx wrapper（daemon detached 存活，CWD 锁定 _npx\...\build）   ← 锁的来源
  → 新 npx 解析 @latest=1.1.1 ≠ 缓存 1.1.0
    → npm 重装：rename 旧包 build 目录 → EBUSY（daemon CWD 占用）             ← 出错点
  → npx 退出非零 → McpDog 连接失败、放弃重连
```

- **上游**：v1.1.0 设计的"客户端退出后 daemon 常驻复用"使锁长期存在；`ensureAdminServer`（`src/cli/stdio-proxy.ts`）是唯一拉起点。
- **下游**：`spawnAdminServerAndWait` 的 `cwd` 决定锁位置；MCP 客户端文件的相对路径解析（`ssh-connection-manager.ts:607` 取 `process.cwd()`）受新 cwd 影响——由"npx 缓存 build 目录"改为"用户主目录"，语义更合理。

## 边缘情况检查

| 维度 | 场景 | 处理 |
|------|------|------|
| 版本回滚 | daemon 版本高于当前包 | 不重启，复用（`compareVersions >= 0` 直接返回） |
| 非数字版本 | 测试桩 `stub`、自编译 `dev` | 正则守卫 `/^\d+\.\d+\.\d+/`，不参与比较、不误杀 |
| PID 误杀 | 端口被非本服务占用 | 前置 `probeAdminServer` 确认是本项目 admin 服务后才查 PID；netstat 本地地址按 `:<port>` 精确后缀匹配，避免 `:6182` 误匹配 `:61823` |
| 并发重启 | 多个 wrapper 同时换新版 | 杀旧后都拉新，后者 EADDRINUSE 自退，探测循环复用先就绪者 |
| 强杀兜底 | SIGTERM 宽限 8s 未退出 | `SIGKILL` 强杀后再拉起（Windows 下 SIGTERM 即强杀） |
| 升级生效 | 只改 cwd 不做版本检查 | 会导致升级静默不生效（旧 daemon 常驻），故配套版本感知重启 |

## 修复内容（v1.1.2）

1. **解除目录锁**（`src/cli/stdio-proxy.ts`）：daemon spawn `cwd` 由 `path.dirname(script)`（包 build 目录）改为 `os.homedir()`。此后 npx 重装不再受运行中 daemon 影响。
2. **版本感知自动换新**：代理启动时对比 `system/info` 返回的 daemon 版本与本包版本，daemon 落后则按端口定位 PID 终止旧进程并拉起新版，保证 `npx @latest` 升级真正生效。

## 遗留与说明

- **一次性过渡**：发布 1.1.2 时，存量 1.1.1 daemon 仍是旧代码（CWD 锁定），首次升级前需手动终止一次旧 daemon（`taskkill` 或重启机器）；此后所有升级全自动。
- **已知限制**：daemon 模式下 `register-mcp` 的 `scope=project`（`src/server/routes/system.ts:53` 基于 `process.cwd()` 拼项目级 `.claude.json`）在 detached 常驻形态下本就无合理语义，cwd 改主目录后等价于 user scope，与修复前（指向 npx 缓存）相比无退化。

## 总结与建议

根因：常驻 daemon 的 CWD 落在 npx 缓存包目录内，Windows 目录锁使 npm 升级重装 rename 失败。已通过"cwd 改主目录 + 版本感知自动换新"根治；本次发布后需手动终止一次存量旧 daemon 完成过渡。
