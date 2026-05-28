# feishu2codex

`feishu2codex` 是一个 TypeScript 飞书机器人。它通过飞书长连接接收
消息，把本机 Codex 或 Claude Code 的流式事件渲染成飞书交互卡片。

仓库支持两个互相独立的机器人进程：一个连接 Codex，一个连接 Claude
Code/DeepSeek。两个进程必须使用不同的飞书 App ID 和 App Secret，也必须使用
不同的会话文件和端口。

项目适合需要把本机 AI coding agent 接入飞书会话的场景。机器人支持会话记忆、
交互卡片、风险审批、执行过程折叠面板、Markdown 回复区，以及本地 slash
命令。

本项目基于原始项目
[YUYU-gdx/feishu2codex](https://github.com/YUYU-gdx/feishu2codex)
改造，主要增加了 Codex SDK 线程持久化、Claude Code `stream-json` runtime、
飞书审批、交互卡片时间线、Markdown 输出优化、slash 命令、Codex Desktop
对话绑定和通用安装文档。

## 功能

核心功能包括以下部分。

- 飞书长连接接收消息，不要求公网回调地址。
- Codex SDK 线程持久化，同一个飞书会话可以延续上下文。
- Claude Code runtime 可以通过 `claude-deepseek-v4` 使用 DeepSeek 模型。
- Codex 和 Claude Code 使用不同飞书应用、不同 env 文件、不同 session 文件。
- 飞书交互卡片展示任务、回复和执行过程。
- 同一飞书会话支持当前任务、等待队列、取消排队和打断插队。
- 高风险任务使用飞书卡片按钮审批。
- 普通问答和只读任务默认直接执行。
- slash 命令支持 `/help`、`/skills`、`/skill`、`/mcp`、
  `/approval`、`/queue`、`/threads`、`/interrupt`、`/cancel`、
  `/clear-queue`、`/model`、`/reset` 和 `/status`。
- 可选使用 Codex `app-server` runtime，让新建对话更容易出现在
  Codex Desktop 侧边栏中。
- 可选使用 `claude-code` runtime，把 Claude Code `stream-json` 输出映射成同一套
  飞书卡片。
- `/threads [keyword]` 可以检索 Codex Desktop 对话，并把选中的 thread 绑定到
  当前飞书会话。
- `/model [model_name] [reasoning_effort]` 可以查看或设置当前飞书会话使用的
  Codex 模型配置。
- 回复区使用飞书 Card JSON 2.0，支持代码块、行内代码标签和原生表格组件。
- 本地 Web 状态接口展示运行状态和日志。

## 系统要求

运行前需要准备以下软件和账号。

- Node.js 18 或更新版本。
- Bun，用于构建 TypeScript 入口。
- 一个飞书自建应用。
- 已登录并可用的 Codex CLI 或 Codex.app 命令行入口。
- 可选：已登录并可用的 Claude Code CLI。
- 可选：可执行的 Claude Code 包装命令，例如 `claude-deepseek-v4`。
- 可选：本机已有 Codex MCP、skills 或其他 agent 资产。

安装 Bun 的方式由运行环境决定。macOS 可以使用 Homebrew 或官方安装脚本。

## 安装

按以下步骤安装依赖并创建本地配置。

1. 克隆仓库。

   ```bash
   git clone https://github.com/christinozhang/feishu2codex.git
   cd feishu2codex
   ```

2. 安装依赖。

   ```bash
   npm install
   ```

3. 创建本地环境变量文件。

   ```bash
   cp .env.example .env
   ```

4. 编辑 `.env`，填写飞书应用凭证和 Codex 运行参数。

   `.env` 包含密钥，不能提交到 Git，也不要发送到聊天工具。

5. 构建项目。

   ```bash
   npm run build
   ```

6. 启动机器人。

   ```bash
   npm start
   ```

启动后，终端出现 `ws client ready` 表示飞书长连接已建立。

## 环境变量

`.env.example` 包含完整模板。常用变量如下。

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=

FEISHU_BOT_OPEN_ID=
FEISHU_BOT_USER_ID=
FEISHU_BOT_UNION_ID=

FEISHU_APPROVAL_ENABLED=true
FEISHU_APPROVAL_BUTTONS_ENABLED=true
FEISHU_APPROVAL_TIMEOUT_MS=60000

CODEX_DEFAULT_SANDBOX_MODE=workspace-write
CODEX_DEFAULT_APPROVAL_POLICY=never
CODEX_PRIVILEGED_SANDBOX_MODE=danger-full-access
CODEX_PRIVILEGED_APPROVAL_POLICY=never

CODEX_PATH_OVERRIDE=
CODEX_WORKING_DIRECTORY=./workspace
CODEX_RUNTIME=exec-sdk
CODEX_DESKTOP_LIST_DIRECTORY=
CODEX_SKIP_GIT_CHECK=true
CODEX_REASONING_EFFORT=medium
CODEX_WEB_SEARCH_ENABLED=true

WEB_PORT=3000
```

变量说明如下。

- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`：飞书开放平台应用凭证。
- `FEISHU_BOT_OPEN_ID`、`FEISHU_BOT_USER_ID` 和
  `FEISHU_BOT_UNION_ID`：机器人身份标识，用于群聊中精确判断是否被
  `@`。填写任意一个即可，推荐填写 `FEISHU_BOT_OPEN_ID`。
- `FEISHU_APPROVAL_ENABLED`：是否启用飞书审批。
- `FEISHU_APPROVAL_BUTTONS_ENABLED`：审批卡片是否显示按钮。
- `CODEX_DEFAULT_SANDBOX_MODE`：普通任务使用的 Codex sandbox。
- `CODEX_PRIVILEGED_SANDBOX_MODE`：审批通过后使用的 Codex sandbox。
- `CODEX_RUNTIME`：Codex 运行后端。默认 `exec-sdk` 使用
  `@openai/codex-sdk` 和 `codex exec`；设置为 `app-server` 时使用
  `codex app-server`，新建对话更容易被 Codex Desktop 索引。
- `CODEX_PATH_OVERRIDE`：Codex 可执行文件路径。macOS 中如果 SDK 自带
  二进制被系统拦截，可以填写 Codex.app 内的已签名命令行入口。
- `CODEX_WORKING_DIRECTORY`：Codex 执行任务时使用的工作目录。
- `CODEX_DESKTOP_LIST_DIRECTORY`：仅用于 Codex Desktop 侧边栏分组和
  `/threads` 检索范围。留空时使用 `CODEX_WORKING_DIRECTORY`。
- `WEB_PORT`：本地状态服务端口，默认是 `3000`。

### Codex 与 Claude Code 独立配置

同一份代码可以启动两个不同的飞书机器人进程。两个进程共享构建产物，但必须
隔离飞书应用、会话文件和端口。

| 进程 | Env 文件 | 飞书应用 | Runtime | Session 文件 | Web 端口 |
| --- | --- | --- | --- | --- | --- |
| Codex bot | `.env` | Codex 飞书应用 | `exec-sdk` 或 `app-server` | `bot_sessions.json` | `3000` |
| Claude bot | `.env.claude` | Claude 飞书应用 | `claude-code` | `bot_sessions.claude.json` | `3001` |

`.env` 继续保存 Codex bot 的飞书凭证。`.env.claude` 保存 Claude bot 的飞书
凭证，且必须来自另一个飞书自建应用。

Claude bot 的最小配置如下。

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BOT_OPEN_ID=
FEISHU_BOT_USER_ID=
FEISHU_BOT_UNION_ID=

FEISHU_LOGGER_LEVEL=info
FEISHU_APPROVAL_ENABLED=true
FEISHU_APPROVAL_BUTTONS_ENABLED=true
FEISHU_APPROVAL_TIMEOUT_MS=60000

CODEX_RUNTIME=claude-code
CLAUDE_CODE_BIN=$HOME/.local/bin/claude-deepseek-v4
CLAUDE_CODE_PERMISSION_MODE=acceptEdits
BOT_SESSION_FILE=bot_sessions.claude.json
CODEX_WORKING_DIRECTORY=$HOME
WEB_PORT=3001
```

`CLAUDE_CODE_BIN` 需要按本机实际安装位置配置。上面的
`$HOME/.local/bin/claude-deepseek-v4` 只是示例路径；如果包装命令在其他目录，
需要改成对应路径或命令名。`CODEX_WORKING_DIRECTORY` 也需要按希望 Claude
Code 执行任务的目录配置。

`claude-code` runtime 会执行 `CLAUDE_CODE_BIN`，并使用 Claude Code 的
`--print --verbose --output-format stream-json --include-partial-messages`
输出模式。`claude-deepseek-v4` 负责把 Claude Code 请求转到 DeepSeek 的
Anthropic 兼容接口。

会话字段也互相独立。

| Runtime | 会话字段 |
| --- | --- |
| `exec-sdk` | `codex_thread_id` |
| `app-server` | `codex_thread_id` |
| `claude-code` | `claude_session_id` |

这个隔离避免 Claude session ID 被当作 Codex thread ID，也避免 Codex thread ID
被传给 `claude --resume`。

可以通过以下命令查询机器人身份标识。

```bash
node scripts/print-bot-info.mjs
```

## 飞书开放平台配置

需要在飞书开放平台创建一个自建应用，并完成凭证、权限、事件和卡片配置。
目标是让机器人通过飞书长连接收发消息，并支持交互卡片审批。

### 创建应用

按以下步骤创建应用。

1. 打开飞书开放平台。
2. 创建企业自建应用。
3. 进入 **凭证与基础信息**。
4. 复制 `App ID` 和 `App Secret` 到 `.env`。

### 开启机器人能力

应用必须启用机器人能力，否则应用无法进入会话收发消息。

配置路径通常为 **应用能力** 或 **添加应用能力** 下的 **机器人**。启用后，
发布应用版本，让机器人能力在租户内生效。

### 配置权限

应用至少需要以下权限。不同租户控制台显示名称可能略有差异，以开放平台实际
权限项为准。

| 权限 | 用途 |
| --- | --- |
| `im:message` | 读取机器人收到的消息事件。 |
| `im:message:send_as_bot` | 以机器人身份回复文本和卡片消息。 |
| `im:message:send_multi` | 群聊或多场景发送消息时使用，按租户权限要求配置。 |
| `im:message:patch` | 更新机器人自己发送的交互卡片。 |

完成权限变更后，创建并发布应用新版本。未发布的新权限不会对线上机器人生效。

如果租户支持权限 JSON 导入，可以直接导入下面这份配置（你提供的版本）。

```json
{
  "scopes": {
    "tenant": [
      "application:application.bot.operator_name:readonly",
      "application:bot.basic_info:read",
      "application:bot.menu:readonly",
      "application:bot.menu:write",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.announcement:read",
      "im:chat.announcement:write_only",
      "im:chat.chat_pins:read",
      "im:chat.chat_pins:write_only",
      "im:chat.collab_plugins:read",
      "im:chat.collab_plugins:write_only",
      "im:chat.managers:write_only",
      "im:chat.members:bot_access",
      "im:chat.members:read",
      "im:chat.members:write_only",
      "im:chat.menu_tree:read",
      "im:chat.menu_tree:write_only",
      "im:chat.moderation:read",
      "im:chat.tabs:read",
      "im:chat.tabs:write_only",
      "im:chat.top_notice:write_only",
      "im:chat.widgets:read",
      "im:chat.widgets:write_only",
      "im:chat:create",
      "im:chat:delete",
      "im:chat:moderation:write_only",
      "im:chat:operate_as_owner",
      "im:chat:read",
      "im:chat:readonly",
      "im:chat:update",
      "im:message",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.urgent.status:write",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_depts",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource"
    ],
    "user": []
  }
}
```

### 配置事件订阅

本项目使用飞书长连接，不需要公网 HTTP 回调地址。

按以下步骤配置事件订阅。

1. 进入 **事件与回调**。
2. 将订阅方式设置为 **使用长连接接收事件**。
3. 添加事件 `im.message.receive_v1`（必要）。
4. 添加事件 `card.action.trigger`（必要，审批按钮回调）。
5. 保存配置并发布应用版本。

`im.message.receive_v1` 用于接收飞书消息。`card.action.trigger` 用于接收
审批卡片上的 `Approve` 和 `Deny` 按钮点击。

从当前代码实现看，以下事件不是必要项（已配置也不会被消费）：`im.chat.access_event.bot_p2p_chat_entered_v1`、`im.message.bot_muted_v1`、`im.message.message_read_v1`、`im.message.reaction.created_v1`、`im.message.reaction.deleted_v1`、`im.message.recalled_v1`。保留它们不会影响运行，但会增加事件噪声。

### 开启交互式卡片

审批按钮和执行状态都依赖飞书交互卡片。

在飞书开放平台确认应用已启用机器人消息卡片或交互式卡片能力。启用后，发送
一条需要审批的任务，卡片中应显示 `Approve` 和 `Deny` 按钮。点击按钮后，
本地日志应出现 `received Feishu card action`。

### 联调验收

完成以上配置后，启动机器人并检查以下结果。

- 启动日志出现 `ws client ready`。
- 在会话中触发高风险任务时，卡片出现 `Approve` 和 `Deny` 按钮。
- 点击按钮后日志出现 `received Feishu card action`。

### 双机器人场景（可选）

同时运行 Codex bot 和 Claude bot 时，需要两个独立飞书应用。

- 使用两套不同的 `App ID` 和 `App Secret`。
- 两边独立配置事件订阅与应用发布。
- 两边独立配置会话文件与监听端口。

## 运行方式

开发和生产使用同一套入口。

```bash
npm run build
npm start
```

也可以使用脚本构建并启动。

```bash
./scripts/start-feishu2codex.sh
```

本地状态服务默认监听 `http://localhost:3000`。修改端口时，在 `.env` 中设置
`WEB_PORT`。

启动 Claude bot 时指定独立 env 文件。

```bash
FEISHU_ENV_FILE=.env.claude ./scripts/start-feishu2codex.sh
```

如果已经构建完成，也可以直接运行 Node 入口。

```bash
FEISHU_ENV_FILE=.env.claude node dist/index.js
```

Claude bot 的本地状态服务按 `.env.claude` 中的 `WEB_PORT` 监听。上面的示例
配置使用 `http://localhost:3001`。

## systemd 或 launchd 部署

仓库不绑定特定部署系统。生产环境只需要运行以下命令即可。

```bash
node dist/index.js
```

macOS 可以用 LaunchAgent 管理进程，Linux 可以用 systemd 管理进程。部署脚本
需要设置工作目录为仓库根目录，并保证 `.env` 文件存在。

macOS 上两个机器人应使用不同的 LaunchAgent label。

| 进程 | LaunchAgent label | Env 文件 | 日志 |
| --- | --- | --- | --- |
| Codex bot | `ai.feishu-codex-bot` | `.env` | `logs/launchd.out.log` 和 `logs/launchd.err.log` |
| Claude bot | `ai.feishu-claude-bot` | `.env.claude` | `logs/launchd.claude.out.log` 和 `logs/launchd.claude.err.log` |

Claude bot 的 LaunchAgent 需要在 `EnvironmentVariables` 中设置
`FEISHU_ENV_FILE=.env.claude` 和 `WEB_PORT=3001`。macOS 用户级 plist 可放在：

```text
~/Library/LaunchAgents/ai.feishu-claude-bot.plist
```

常用管理命令如下。

```bash
launchctl print gui/$(id -u)/ai.feishu-claude-bot
launchctl kickstart -k gui/$(id -u)/ai.feishu-claude-bot
launchctl enable gui/$(id -u)/ai.feishu-claude-bot
```

`RunAtLoad=true`、`KeepAlive=true` 且服务状态为 `enabled` 时，Claude bot 会在
当前 macOS 用户登录后自动启动。

## 飞书使用方式

私聊机器人时，直接发送文本即可。群聊中默认需要 `@` 机器人。

常用命令如下。

- `/help`：查看命令说明。
- `/skills [keyword]`：列出本机可用 skills。
- `/skill <name> <task>`：用指定 skill 改写任务并交给 Codex。
- `/mcp`：查看当前 Codex CLI 可见 MCP。
- `/approval`：查看审批策略。
- `/queue`：查看当前任务和等待队列。
- `/threads [keyword]`：检索 Codex Desktop 对话，并用卡片按钮绑定到当前
  飞书会话。
- `/interrupt <task>`：打断当前任务，并把新任务放到队首执行。
- `/cancel <task_id>`：取消一个等待任务。
- `/clear-queue`：清空当前会话中属于当前用户的等待任务。
- `/model [model_name] [reasoning_effort]`：查看或设置当前飞书会话使用的
  Codex 模型配置。
- `/reset`：清空当前飞书会话绑定的 Codex thread。
- `/status`：查看机器人状态。

普通问答和只读查询默认直接执行。命中写文件、删除、重启、部署、安装、提交、
推送、配置修改、外部系统或 MCP 等关键词的任务，会先发送飞书审批卡片。

同一飞书会话中只能有一个 Codex turn 正在运行。当前任务运行期间继续发送普通
消息时，机器人会发送入队卡片。入队卡片提供 **打断并执行** 和 **取消排队**
按钮；运行卡片提供 **打断** 和 **查看队列** 按钮。被打断的任务不会自动恢复，
如果仍需继续，需要重新发送任务。

## 回复格式

机器人使用飞书 Card JSON 2.0 渲染 Codex 回复。代码块保留 Markdown fenced
code block，行内代码会转换成飞书 `text_tag` 标签，Markdown 表格会转换成飞书
原生 `table` 组件。

表格组件遵循飞书限制：单张卡片最多渲染 5 个表格，每个表格最多展示 6 列和
10 行。超出部分会降级为列表文本，避免飞书拒绝创建或更新卡片。

## Codex Desktop 对话绑定

当 `CODEX_RUNTIME=app-server` 时，机器人通过 `codex app-server` 创建和恢复
thread。该模式创建的 thread 更容易出现在 Codex Desktop 侧边栏中。

发送 `/threads [keyword]` 后，机器人会返回最近的 Codex Desktop 对话卡片。
卡片只展示 thread 标题、工作目录和更新时间。点击 **绑定** 后，当前飞书会话
会记录对应的 `codex_thread_id`。后续消息会继续这个 thread，但不会把历史聊天
内容回放到飞书卡片中。

## Claude Code/DeepSeek runtime

当 `CODEX_RUNTIME=claude-code` 时，机器人不会启动 Codex SDK，也不会调用
`codex app-server`。它会启动 `CLAUDE_CODE_BIN`，读取 Claude Code 的
`stream-json` 输出，并映射成现有飞书卡片事件。

Claude 进程的入口由 `.env.claude` 中的 `CLAUDE_CODE_BIN` 决定。以下是示例
路径。

```text
$HOME/.local/bin/claude-deepseek-v4
```

该包装命令需要设置 DeepSeek 的 Anthropic 兼容环境变量，然后执行 `claude`。
机器人启动 Claude Code 的参数为：

```bash
--print \
--verbose \
--output-format stream-json \
--include-partial-messages
```

如果当前飞书会话已有 `claude_session_id`，机器人还会传入：

```bash
--resume <claude_session_id>
```

Claude bot 的卡片标题会显示 `Claude Code/DeepSeek 正在处理`。如果需要修改显示
名称，可以在 `.env.claude` 中设置：

```env
CLAUDE_CODE_DISPLAY_NAME=Claude Code/DeepSeek
```

`/threads` 是 Codex `app-server` 的能力。Claude bot 没有 Codex Desktop thread
列表协议，因此在 `claude-code` runtime 下不会提供 Desktop thread 选择。

### 验证 Claude Code/DeepSeek 调用

查看 Claude bot 日志可以确认实际调用链。

```bash
tail -f logs/launchd.claude.out.log | rg 'Runtime|ClaudeCode'
```

正常请求会出现类似日志：

```text
[Runtime] requesting Claude Code/DeepSeek kind=claude-code
[ClaudeCode] start bin=$HOME/.local/bin/claude-deepseek-v4 ...
[ClaudeCode] init session=... model=deepseek-v4-pro[1m] version=...
[ClaudeCode] result session=... status=success ... modelUsage=deepseek-v4-pro[1m],deepseek-v4-flash
```

关键字段含义如下。

- `kind=claude-code` 表示当前运行后端不是 Codex。
- `bin=$HOME/.local/bin/claude-deepseek-v4` 表示启动了本机
  Claude Code/DeepSeek 包装命令。
- `model=deepseek-v4-pro[1m]` 或 `modelUsage=deepseek...` 表示 Claude Code
  通过 DeepSeek 模型返回。

## 会话与数据文件

机器人会在仓库根目录创建运行态文件。

- `bot_sessions.json`：飞书会话到 Codex thread 的映射。
- `bot_sessions.claude.json`：飞书会话到 Claude Code session 的映射。
- `logs/`：进程管理器或运行脚本输出的日志目录。
- `dist/`：构建产物。
- `.env`：Codex bot 的飞书凭证和 runtime 配置。
- `.env.claude`：Claude bot 的飞书凭证和 runtime 配置。

这些文件不提交到 Git。迁移机器时，如果需要保留会话上下文，可以手动迁移
对应的 `bot_sessions*.json` 文件。

## 开发

修改代码后执行以下验证。

```bash
npm test
npx tsc --noEmit
npm run build
```

代码结构如下。

- `src/index.ts`：飞书 WebSocket、消息路由、审批和 runtime 编排。
- `src/runtime.ts`：Codex SDK、Codex app-server 和 Claude Code runtime 选择。
- `src/appServerRuntime.ts`：Codex app-server JSON-RPC 适配。
- `src/claudeCodeRuntime.ts`：Claude Code `stream-json` 适配。
- `src/streaming.ts`：runtime 事件模型、卡片渲染、Markdown 处理和脱敏。
- `src/session.ts`：会话文件兼容和更新。
- `src/queue.ts`：同一飞书会话内的当前任务、等待队列、取消和打断插队。
- `src/approval.ts`：风险关键词和 Codex 运行策略。
- `src/slash.ts`：slash 命令解析和本地命令。
- `src/server.ts`：本地状态接口。
- `tests/*.test.mjs`：审批、会话、slash 和卡片回归测试。

## 常见问题

### 机器人没有回复

检查以下项目。

- `.env` 中 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 是否正确。
- 飞书应用是否已发布到当前租户。
- 事件订阅是否使用长连接。
- 是否已订阅 `im.message.receive_v1`。
- 群聊消息是否 `@` 了机器人。
- 启动日志中是否出现 `ws client ready`。

### 审批按钮点击后没有反应

检查以下项目。

- 是否订阅了 `card.action.trigger`。
- 是否启用了交互式卡片能力。
- 是否发布了应用新版本。
- `.env` 中 `FEISHU_APPROVAL_BUTTONS_ENABLED` 是否为 `true`。
- 本地日志中是否出现 `received Feishu card action`。

### macOS 阻止 Codex 二进制运行

如果系统提示某个 Codex 二进制被阻止，可以把 `CODEX_PATH_OVERRIDE` 设置为
已安装 Codex.app 内的签名命令行入口，或者设置为本机可直接运行的 `codex`
命令路径。

### 回复卡片没有更新

检查应用是否具备更新机器人消息的权限，并确认 `im:message:patch` 已申请、
审批和发布。卡片更新失败时，机器人会尝试退回到文本回复。

### Claude bot 卡片仍显示 Codex

检查 Claude bot 是否运行了新构建产物，并确认进程已重启。

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/ai.feishu-claude-bot
tail -n 40 logs/launchd.claude.out.log | rg 'Runtime|Claude'
```

日志中应出现 `name=Claude Code/DeepSeek kind=claude-code`。旧卡片已经发送到
飞书后不会自动改标题，需要用新消息验证。

### 无法确认 Claude bot 是否调用 DeepSeek

检查 Claude bot 日志中的 Claude Code 初始化和 result 事件。

```bash
tail -f logs/launchd.claude.out.log | rg 'ClaudeCode'
```

日志中应出现 `bin=$HOME/.local/bin/claude-deepseek-v4`，以及
`model=deepseek-v4-pro[1m]` 或 `modelUsage=deepseek...`。这些字段来自
Claude Code 的 `stream-json` 输出，不来自飞书卡片。

## 安全注意事项

`.env`、`.env.claude`、token、cookie、password、`Authorization` header 和
飞书 `App Secret` 不能提交到 Git。卡片渲染层会对常见敏感字段做脱敏，但运行
日志和第三方工具输出仍需要按最小暴露原则处理。

## 许可证

本项目使用 MIT License。详情见 [LICENSE](LICENSE)。
