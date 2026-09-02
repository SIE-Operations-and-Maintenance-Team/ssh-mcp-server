# Bug 诊断报告：PublishTools 同步后主机名称为空、编辑保存变新增

- **日期**：2026-09-02
- **状态**：已修复（同日完成，验证记录见文末）
- **严重级别**：P1 严重（数据展示缺失 + 编辑操作语义错误，产生残留脏数据）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）

---

## 问题描述

用户报告两个问题（均为桌面版 Tauri，v1.0.4）：

1. 从 PublishTools 同步数据过来后，服务器的名称显示是空的，但编辑时其它数据都在，保存却提示"名称已存在"。
2. 编辑已有主机保存时会变成新增（用户推测可能与数据加载时名字不对有关）。

## 环境信息

- 分支/版本：main（da1c49b，桌面版 v1.0.4）
- 相关模块：`src-tauri/src/admin_http.rs`（导入 API）、`admin-web/src/pages/Connections.tsx`（连接管理页）、`src-tauri/src/config.rs`（HostConfig 定义）
- 配置文件：`C:\ProgramData\SshMcpServer\config.json`
- 复现步骤：PublishTools 生成 projects 格式 JSON（主机名只在 hosts map 的 key 上，对象内无 name 字段）→ 桌面版"导入 JSON" → 主机列表名称列为空 → 点"编辑" → 表单其它字段有值、名称为空 → 填入名称保存

---

## 结论（一句话）

桌面版 `config_import` 的 projects 分支导入主机时**没有把 hosts map 的 key 回填到主机对象内部的 `name` 字段**（Node 版每个路径都有回填，移植时遗漏），导致 `HostConfig.name` 为空字符串；前端列表、编辑弹窗、`editingHost` 编辑标识全部依赖对象内 `name`，于是"名称显示空"（问题 1 前半）、"原名称被当新增撞 key 报'主机已存在'"（问题 1 后半）、"改名保存变成新增且旧记录残留"（问题 2）三个现象同源。

---

## 可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | 桌面版 `config_import` projects 分支未回填 `hc.name = h_name`，且 `HostConfig.name` 带 `#[serde(default)]`，源 JSON 缺 name 时静默空串 | **高（已证实）** | admin_http.rs:771-813 两条插入路径均无回填；legacy 分支 admin_http.rs:886 却有 `hc.name = h_name.clone()`；Node 版 admin.ts:568/604/627 三处均有 `{ ...hVal, name: hName }` 回填 |
| 2 | 前端展示层读错字段（读对象 name 而非 map key） | 中（是放大因素，非根因） | Connections.tsx:649 `dataIndex: "name"`；`getOrderedHosts` 用 `Object.values()` 丢掉了 key 信息 |
| 3 | 编辑标识 `editingHost` 依赖 `rec.name`，name 为空导致 `originalName` 缺失、后端走新增分支 | **高（已证实）** | Connections.tsx:359 `setEditingHost(rec.name)`、:420 `originalName: editingHost \|\| undefined`；admin_http.rs:390-418 `original=None` 时按 `contains_key` 判重 |
| 4 | PublishTools 生成的 JSON 本身缺 name 字段 | 高（已证实为输入形态） | 本机配置 4 台主机 key 正常、name 全空，环境名均为"导入" |
| 5 | `unwrap_or_default()` 吞掉反序列化错误导致整项目变空 | 低（独立隐患） | admin_http.rs:773 字段类型不匹配时整个 ProjectConfig 静默变 default，与本现象不符但值得记录 |

## 实锤验证（已完成）

`C:\ProgramData\SshMcpServer\config.json` 实测（2026-09-02）：

```
项目[ManmanCloud] 环境[生产环境]        key=[广州]                name=['广州']   ← 手工新建，正常对照
项目[扬兴科技]     环境[导入]           key=[扬兴-正式环境]        name=['']
项目[津荣-天新-测试] 环境[导入]         key=[津荣-天新测试环境-1.10] name=['']     ← 4 台 PublishTools
项目[津荣-测试]   环境[导入]           key=[津荣-测试环境-130.100] name=['']      ← 同步主机全部
项目[英科淮北-测试环境] 环境[导入]      key=[英科淮北测试服务器-2.96] name=['']    ← name 为空
```

数据层 key 完好、对象内 name 全空——与"显示为空但数据存在、保存撞'已存在'"的现象完全一致。

## 调用链与依赖分析

### 问题 1 完整链路（名称空 + "名称已存在"）

```
PublishTools JSON: projects.X.environments.Y.hosts = { "扬兴-正式环境": { host, port, ... } }  ← 对象内无 name
  → 桌面版 config_import projects 分支        [src-tauri/src/admin_http.rs:771-813]
      serde_json::from_value::<ProjectConfig> → HostConfig.name 用 #[serde(default)] 补空串   ← ★根因（无回填）
      old_env.hosts.insert(h_name, hc)        [admin_http.rs:800]  ← key 正常写入
  → project_get 返回 hosts 对象               [admin_http.rs:196-203]
  → 前端 getOrderedHosts 取 Object.values()   [admin-web/src/pages/Connections.tsx:67-77]（key 信息在此丢失）
  → 表格 dataIndex:"name" 读对象内 name        [Connections.tsx:649]                          ← 名称列显示空
  → openEditHost: setEditingHost(rec.name="")  [Connections.tsx:359]
  → saveHost: originalName: "" || undefined = undefined  [Connections.tsx:420]
  → 后端 host_save: original=None → 判定新增    [admin_http.rs:390]
  → contains_key("扬兴-正式环境")=true 且 original=None
  → err400 HOST_EXISTS "主机已存在: 扬兴-正式环境"  [admin_http.rs:414-417]                   ← "名称已存在"
```

### 问题 2 完整链路（编辑变新增）

同一前因：`editingHost=""` → `originalName=undefined` → 后端新增分支。

- 用户填回原名称：撞 `contains_key` → 报"主机已存在"（问题 1 后半）
- 用户填新名称：`contains_key(新名)=false` → `insert(新名)` **新增一条**，原空名主机残留 [admin_http.rs:419] → 表现为"编辑变成新增"

### 关键对照：Node 版行为正确

`src/server/routes/admin.ts` projects 分支三条路径（新项目 :568、新环境 :604、合并主机 :627）全部执行：

```ts
const parsed = ConnectionSchema.passthrough().parse({ ...(hVal as any), name: hName });  // 强制 name=key
normalized.name = hName;                                                                  // 二次回填
```

桌面版仅 legacy connections 分支保留了等价逻辑（admin_http.rs:886 `hc.name = h_name.clone()`），projects 分支移植时遗漏。

## 边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 说明 |
|------|------|----------|------------|------|
| MCP 侧连接查找 | 按 name 连接主机 | `flatten_hosts`/resolve 用 **map key** 匹配（config.rs:218-230），非对象内 name | 否 | MCP 工具不受此 bug 影响 |
| 主机删除/排序 | deleteHost / hosts_reorder | 后端均按 key 操作（admin_http.rs:430-445 / 704-733） | 部分 | 后端正常；但前端 `deleteHost(rec)`、`moveHost` 传 `rec.name`（空串）→ **删除/拖拽这些主机也会失败**（`hosts/{host}` 路由收到空名 → HOST_NOT_FOUND） |
| 测试连接 | test(rec) | 用 host/port/username，不用 name | 否 | 正常 |
| 密码保留语义 | 空名主机保存 | `lookup = original.or(conn.name)`（admin_http.rs:397），撞名时仍能查到旧密码 | 否 | 附带行为，非问题 |
| 导入解析容错 | 源 JSON 字段类型不匹配 | `from_value(...).unwrap_or_default()`（admin_http.rs:773）**整个项目静默变空项目**，无任何 warning | 是（独立隐患） | 违反"错误必须上报"原则，建议改为逐主机解析+warning（Node 版即如此） |
| 存量脏数据 | 已导入的 4 台主机 | name 已持久化为空串 | 是 | 只修导入代码不够，需数据迁移 |
| hostOrder | 同步环境 hostOrder=[] | `getOrderedHosts` 回退 `Object.values`（BTreeMap 序） | 否 | 展示顺序正常 |

## 修复建议（按优先级）

1. **核心修复 — 导入回填 name**（admin_http.rs config_import projects 分支）：
   - 新项目路径（:777-781）：`from_value` 后遍历 `proj.environments` 的每个 `(h_name, hc)` 执行 `hc.name = h_name.clone()`（注意 `h_name` 为空白时应 push warning 跳过，对齐 Node 版 :563-565）；
   - 合并路径（:799-805）：`insert(h_name, hc)` 前同样回填。
2. **存量数据迁移**：在 `config::load()` 之后（或新增一次性归一化步骤）遍历全部 hosts，`if hc.name.trim().is_empty() { hc.name = h_name }` 并回存。仅修导入代码无法治愈本机已存在的 4 台空名主机。
3. **前端防御（可选，后端归一化后可不改）**：`getOrderedHosts` 返回时兜底 `name: hc.name || key`，使展示/编辑标识不再依赖对象内字段与 key 的一致性。
4. **顺带修复（建议）**：`config_import` 的 `unwrap_or_default()` 改为逐项目/逐主机解析，失败项记入 warnings，对齐 Node 版行为，避免整项目静默清空。

修复后验证方式：
- 用 PublishTools 格式（对象内无 name）JSON 重新导入 → 列表名称正常显示；
- 编辑该主机不改名直接保存 → 成功且不产生新记录；
- 编辑改名保存 → 原记录改名而非新增残留；
- 检查 `C:\ProgramData\SshMcpServer\config.json` 中 key 与 name 一致。

## 总结

两个问题同源：桌面版导入遗漏 name 回填（与 Node 版行为漂移），空 `name` 使列表显示、编辑标识（originalName）双双失效。修复 = 导入回填 + 存量数据归一化，改动集中在 `src-tauri/src/admin_http.rs` 与 `src-tauri/src/config.rs`，风险低。

---

## 修复记录（2026-09-02 同日实施）

| # | 改动 | 文件 |
|---|------|------|
| 1 | config_import projects 分支：解析失败记 warning 跳过（不再 `unwrap_or_default` 静默清空整项目）；主机 name 缺失用 key 回填；key 空白的主机跳过并告警 | `src-tauri/src/admin_http.rs` |
| 2 | 新增 `GlobalConfig::normalize_host_names()`（幂等）；`load()` 拆出 `load_raw()`，读路径统一归一化兜底；新增 `config::migrate()` 启动迁移（原始数据脏才落盘）；main.rs setup 最早调用 | `src-tauri/src/config.rs`、`src-tauri/src/main.rs` |
| 3 | Node 版 `load()` 在 Zod parse **之前**归一化原始 JSON（ConnectionSchema.name 有 min(1) 约束，空 name 不先修会让 Node 版整个 load 抛错——这是诊断阶段发现的连带问题） | `src/services/config-store.ts` |
| 4 | 前端 `getOrderedHosts` 兜底：对象内 name 为空时用 map key 补齐（展示/rowKey/editingHost 一致） | `admin-web/src/pages/Connections.tsx` |

### 验证结果

- `cargo test --lib`（src-tauri）：12 passed / 0 failed，含新增 3 条归一化单测（回填、幂等、空白 key 不回填）
- `npm run build`（Node tsc）：成功
- `npm --prefix admin-web run build`（vite）：成功；`tsc --noEmit` 源码无错误（node_modules 内 antd/rc-picker 依赖声明既有报错与本次无关）
- `node --test "test/**/*.test.js"`：239 tests / 237 pass / 0 fail / 2 skipped（既有条件跳过），含新增用例 `should backfill empty host name from map key on load`
- 真实数据回归：本机 `C:\ProgramData\SshMcpServer\config.json` 的 4 台 PublishTools 同步主机（扬兴科技、津荣×2、英科淮北）经修复后 Node 版 load，name 全部由空串回填为 key 值

### 存量数据治愈路径

桌面版下次启动时 `config::migrate()` 自动把 4 台主机 name 回填落盘（写前生成 .bak）；此前 Node 版/前端读兜底已保证界面显示与编辑行为正确。
