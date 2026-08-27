---
name: ssh-mcp-helper
description: Use when 用户希望安装、配置或新增 ssh-mcp-server 的 MCP 连接（如「帮我装一下 ssh-mcp-server」「给 Cursor/Claude Code 配置 SSH MCP」「在已有 MCP 里加一台远程主机」「ssh-mcp-server 的 mcp.json 怎么写」）。技能通过逐步问答收集主机、认证、传输模式、命令限制等参数，并把生成的 mcpServers JSON 片段写入对应客户端的配置文件。
---

# ssh-mcp-helper

## 概述

帮助用户通过交互式问答完成 `@sieop/ssh-mcp-server` 的安装预检与 MCP 客户端配置。技能本身**不代替用户输入凭据**，而是逐项确认认证方式、连接参数与安全策略，最终产出可直接写入 MCP 客户端配置文件的 `mcpServers` JSON 片段。

**核心准则：** 所有可枚举的选项（MCP 客户端类型、认证方式、传输模式、是/否开关）必须使用 AskUserQuestion 让用户选择；只有不可枚举的输入（host、用户名、私钥路径、密码、自定义白名单正则等）才允许自由文本提问。

## 何时使用

- 用户明确要安装/配置/新增 ssh-mcp-server
- 用户提到为 Cursor / Claude Code / Cline / Continue 等客户端添加 SSH MCP
- 用户希望在已有 `mcpServers` 中追加一台 SSH 主机
- 用户问「ssh-mcp-server 的 mcp.json 怎么写」

## 何时不使用

- 用户要修改 ssh-mcp-server 源码 → 直接编辑代码，不进入向导
- 用户只是想跑某条 SSH 命令 → 直接调用已存在的 ssh-mcp-server 工具
- 用户在问 SSH 协议本身的概念 → 解释即可，无需走流程

## 工作流程

```dot
digraph ssh_mcp_helper {
    "0. 前置环境检查" [shape=box];
    "1. 选择 MCP 客户端" [shape=box];
    "2. 单台 vs 多台" [shape=diamond];
    "3. 选择认证方式" [shape=box];
    "4. 询问连接参数" [shape=box];
    "5. 询问高级选项" [shape=box];
    "6. 生成 JSON 片段" [shape=box];
    "7. 合并写入配置" [shape=box];
    "8. 提示重启与验证" [shape=doublecircle];

    "0. 前置环境检查" -> "1. 选择 MCP 客户端";
    "1. 选择 MCP 客户端" -> "2. 单台 vs 多台";
    "2. 单台 vs 多台" -> "3. 选择认证方式" [label="单台"];
    "2. 单台 vs 多台" -> "3. 选择认证方式" [label="多台 → 写 ssh-config.json"];
    "3. 选择认证方式" -> "4. 询问连接参数";
    "4. 询问连接参数" -> "5. 询问高级选项";
    "5. 询问高级选项" -> "6. 生成 JSON 片段";
    "6. 生成 JSON 片段" -> "7. 合并写入配置";
    "7. 合并写入配置" -> "8. 提示重启与验证";
}
```

### Step 0：前置环境检查
- 运行 `node -v` 与 `npx --version` 确认本机有 Node.js（推荐 v18+）
- 缺失则先提示用户安装 Node.js，再继续后续步骤

### Step 1：选择 MCP 客户端（AskUserQuestion 多选一）

| 客户端 | 默认配置位置 |
|---|---|
| Claude Code（全局） | `~/.claude.json` 的 `mcpServers` 字段 |
| Claude Code（项目级） | 项目根 `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| Cline / Continue / 其他 | 让用户提供具体路径 |

### Step 2：单台 vs 多台（AskUserQuestion 二选一）
- **单台**：直接使用命令行参数（`--host` 等）
- **多台**：生成 `ssh-config.json` 并使用 `--config-file`

### Step 3：选择认证方式（AskUserQuestion 多选一）
- `password` — 账号 + 密码
- `privateKey` — 账号 + 私钥；再用 AskUserQuestion 确认是否带 passphrase
- `ssh-config` — 复用 `~/.ssh/config` 中的 Host 别名（只需 `--host <alias>`，可选 `--ssh-config-file`）
- `ssh-agent` — 使用 `--agent` 指向 socket
- `2fa` — 密码 + 私钥 + 键盘交互，追加 `--try-keyboard`

### Step 4：连接参数（自由文本）
- host / port / username（port=22 可省略）
- 按 Step 3 的结果追问密码、私钥路径、passphrase、agent socket 等

### Step 5：高级选项（每项独立用 AskUserQuestion 询问是/否）
1. SOCKS 代理：是 → 追问 `--socksProxy` 字符串
2. 命令白名单：是 → 追问逗号分隔正则（**生产环境强烈建议开启**）
3. 命令黑名单：是 → 追问逗号分隔正则
4. 命令模板：是 → 追问含 `<command>` 占位符的模板
5. 传输模式：默认 `exec`；若用户标记目标为堡垒机/跳板机，改 `shell` 并追问 `--shell-ready-timeout`
6. 路径白名单：是 → 追问 `--allowed-local-paths` / `--allowed-remote-paths`
7. 启动时预连接：是 → 追加 `--pre-connect`

### Step 6：生成 JSON 片段
装配规则：
- `command` 固定为 `"npx"`
- `args` 第一项 `"-y"`，第二项 `"@sieop/ssh-mcp-server"`
- **每个命令行参数与值必须是 args 数组中独立的两个元素**，绝不能写成 `"--host 192.168.1.1"`
- 多连接场景：把每个连接写入 `ssh-config.json`（数组或对象格式皆可），客户端配置里只放 `--config-file <绝对路径>`

### Step 7：合并写入配置
- 先用 Read 读取目标 JSON 配置文件
- 合并到既存 `mcpServers` 下；若存在同名 key，**先 AskUserQuestion 让用户选择覆盖 / 改名 / 取消**
- 写入前把最终片段展示给用户确认
- 写入后输出该配置文件的绝对路径

### Step 8：收尾
- 提示用户重启对应 MCP 客户端使配置生效
- 给出验证方式：调用 `list-servers`，或对该连接执行 `execute-command "whoami"`

## 速查表

| 场景 | 关键参数 |
|---|---|
| 账号密码 | `--host --port --username --password` |
| 私钥（可带 passphrase） | `--host --port --username --privateKey [--passphrase]` |
| 复用 ssh config 别名 | `--host <alias>` (+可选 `--ssh-config-file`) |
| SOCKS 代理 | `--socksProxy socks://user:pwd@host:port` |
| 堡垒机 / 跳板机 | `--transport-mode shell --shell-ready-timeout 15000` |
| 多连接 | `--config-file /abs/path/ssh-config.json` |
| 2FA / MFA | `--try-keyboard`（搭配密码 + 私钥） |
| 命令白名单 | `--whitelist "^ls( .*)?,^cat .*"` |
| 命令黑名单 | `--blacklist "^rm .*,^shutdown.*"` |
| 命令模板 | `--command-template "su root -c '<command>'"` |
| 路径白名单 | `--allowed-local-paths` / `--allowed-remote-paths` |

## 常见坑

- ❌ 把 `"--host 192.168.1.1"` 当作一个 args 元素 → ✅ 拆成两个元素 `"--host", "192.168.1.1"`
- ❌ 密码含 `{ } = ,` 等字符却用旧式 `--ssh "name=...,password=..."` → ✅ 改用 `--config-file` 或 JSON 形式 `--ssh`
- ❌ `shell` 模式下还想用 `upload`/`download` → 该模式禁用 SFTP，需切回 `exec`
- ❌ 直接覆盖用户既有 `mcpServers` 中的同名 key → 必须先读后合并，覆盖前显式确认
- ❌ 直连生产环境却未配置 `--whitelist` / `--blacklist` → 必须主动提醒安全风险
- ❌ 把私钥内容粘进配置 → 配置里应填**私钥文件路径**，凭据留在本地

## 输出示例

最简单的账号密码场景产出：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@sieop/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "pwd123456",
        "--whitelist", "^ls( .*)?,^cat .*"
      ]
    }
  }
}
```

多连接场景产出 `ssh-config.json` + 简化的客户端配置：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": ["-y", "@sieop/ssh-mcp-server", "--config-file", "/abs/path/ssh-config.json"]
    }
  }
}
```
