# feishu2codex

`feishu2codex` 是一个 TypeScript 飞书机器人。它通过飞书长连接接收
消息，通过 `@openai/codex-sdk` 启动 Codex，并把 Codex 的流式事件渲染
成飞书交互卡片。

项目适合需要把 Codex 接入飞书会话的场景。机器人支持会话记忆、交互卡片、
风险审批、执行过程折叠面板、Markdown 回复区，以及本地 slash 命令。

本项目基于原始项目
[YUYU-gdx/feishu2codex](https://github.com/YUYU-gdx/feishu2codex)
改造，主要增加了 Codex SDK 线程持久化、飞书审批、交互卡片时间线、
Markdown 输出优化、slash 命令和通用安装文档。

## 功能

核心功能包括以下部分。

- 飞书长连接接收消息，不要求公网回调地址。
- Codex SDK 线程持久化，同一个飞书会话可以延续上下文。
- 飞书交互卡片展示任务、回复和执行过程。
- 高风险任务使用飞书卡片按钮审批。
- 普通问答和只读任务默认直接执行。
- slash 命令支持 `/help`、`/skills`、`/skill`、`/mcp`、
  `/approval`、`/reset` 和 `/status`。
- 本地 Web 状态接口展示运行状态和日志。

## 系统要求

运行前需要准备以下软件和账号。

- Node.js 18 或更新版本。
- Bun，用于构建 TypeScript 入口。
- 一个飞书自建应用。
- 已登录并可用的 Codex CLI 或 Codex.app 命令行入口。
- 可选：本机已有 Codex MCP、skills 或其他 agent 资产。

安装 Bun 的方式由运行环境决定。macOS 可以使用 Homebrew 或官方安装脚本。

## 安装

按以下步骤安装依赖并创建本地配置。

1. 克隆仓库。

   ```bash
   git clone https://git.garena.com/christino.zhang/feishu2codex.git
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
- `CODEX_PATH_OVERRIDE`：Codex 可执行文件路径。macOS 中如果 SDK 自带
  二进制被系统拦截，可以填写 Codex.app 内的已签名命令行入口。
- `CODEX_WORKING_DIRECTORY`：Codex 执行任务时使用的工作目录。
- `WEB_PORT`：本地状态服务端口，默认是 `3000`。

可以通过以下命令查询机器人身份标识。

```bash
node scripts/print-bot-info.mjs
```

## 飞书开放平台配置

需要在飞书开放平台创建一个自建应用，并完成凭证、权限、事件和卡片配置。

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

### 配置事件订阅

本项目使用飞书长连接，不需要公网 HTTP 回调地址。

按以下步骤配置事件订阅。

1. 进入 **事件与回调**。
2. 将订阅方式设置为 **使用长连接接收事件**。
3. 添加事件 `im.message.receive_v1`。
4. 添加事件 `card.action.trigger`。
5. 保存配置并发布应用版本。

`im.message.receive_v1` 用于接收飞书消息。`card.action.trigger` 用于接收
审批卡片上的 `Approve` 和 `Deny` 按钮点击。

### 开启交互式卡片

审批按钮和执行状态都依赖飞书交互卡片。

在飞书开放平台确认应用已启用机器人消息卡片或交互式卡片能力。启用后，发送
一条需要审批的任务，卡片中应显示 `Approve` 和 `Deny` 按钮。点击按钮后，
本地日志应出现 `received Feishu card action`。

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

## systemd 或 launchd 部署

仓库不绑定特定部署系统。生产环境只需要运行以下命令即可。

```bash
node dist/index.js
```

macOS 可以用 LaunchAgent 管理进程，Linux 可以用 systemd 管理进程。部署脚本
需要设置工作目录为仓库根目录，并保证 `.env` 文件存在。

## 飞书使用方式

私聊机器人时，直接发送文本即可。群聊中默认需要 `@` 机器人。

常用命令如下。

- `/help`：查看命令说明。
- `/skills [keyword]`：列出本机可用 skills。
- `/skill <name> <task>`：用指定 skill 改写任务并交给 Codex。
- `/mcp`：查看当前 Codex CLI 可见 MCP。
- `/approval`：查看审批策略。
- `/reset`：清空当前飞书会话绑定的 Codex thread。
- `/status`：查看机器人状态。

普通问答和只读查询默认直接执行。命中写文件、删除、重启、部署、安装、提交、
推送、配置修改、外部系统或 MCP 等关键词的任务，会先发送飞书审批卡片。

## 会话与数据文件

机器人会在仓库根目录创建运行态文件。

- `bot_sessions.json`：飞书会话到 Codex thread 的映射。
- `logs/`：进程管理器或运行脚本输出的日志目录。
- `dist/`：构建产物。

这些文件不提交到 Git。迁移机器时，如果需要保留会话上下文，可以手动迁移
`bot_sessions.json`。

## 开发

修改代码后执行以下验证。

```bash
npm test
npx tsc --noEmit
npm run build
```

代码结构如下。

- `src/index.ts`：飞书 WebSocket、消息路由、审批和 Codex SDK 编排。
- `src/streaming.ts`：Codex 事件模型、卡片渲染、Markdown 处理和脱敏。
- `src/session.ts`：会话文件兼容和更新。
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

## 安全注意事项

`.env`、token、cookie、password、`Authorization` header 和飞书
`App Secret` 不能提交到 Git。卡片渲染层会对常见敏感字段做脱敏，但运行日志
和第三方工具输出仍需要按最小暴露原则处理。

## 许可证

本项目使用 MIT License。详情见 [LICENSE](LICENSE)。
