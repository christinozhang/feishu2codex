# Claude Code independent runtime spec

## Background

`feishu2codex` currently runs one Feishu bot process that connects one Feishu
application to Codex. The requested change is to add a Claude Code runtime that
can use a local `claude-deepseek-v4` command, while keeping the current Codex
connection unchanged.

The Codex bot and Claude bot must be operationally independent. They must use
different Feishu application credentials and must not overwrite each other's
session state.

## Goals

- Keep the current Codex bot behavior unchanged when no new configuration is
  present.
- Run the Claude Code bot as a separate process with its own Feishu App ID and
  App Secret.
- Store Codex thread IDs and Claude session IDs in separate fields.
- Store Codex bot state and Claude bot state in separate session files.
- Let the Claude Code process use `claude-deepseek-v4` through Claude Code's
  `stream-json` output mode.
- Reuse the existing Feishu queue, approval, interruption, and card rendering
  code as much as possible.

## Non-goals

- Do not merge two Feishu applications into one Node process.
- Do not replace the existing `exec-sdk` or `app-server` Codex runtime.
- Do not make Codex Desktop thread selection work for Claude Code sessions.
- Do not reuse Claude Max usage or summary generation code from
  `joewongjc/feishu-claude-code`.
- Do not change existing `.env` credential names in the Codex process.

## Runtime model

The system will support two independently started bot processes.

### Codex process

The Codex process remains the existing default process. It loads `.env` unless a
custom env file is configured. Existing deployments that use `.env` keep the
same behavior.

Required properties:

- Uses the existing Codex Feishu application credentials.
- Uses `CODEX_RUNTIME=exec-sdk` or `CODEX_RUNTIME=app-server`.
- Uses the existing `bot_sessions.json` session file by default.
- Stores Codex conversation identity in `codex_thread_id`.

### Claude Code process

The Claude Code process is a second bot process. It loads a separate env file
and connects to a separate Feishu application.

Required properties:

- Uses a different `FEISHU_APP_ID`.
- Uses a different `FEISHU_APP_SECRET`.
- Uses `CODEX_RUNTIME=claude-code`.
- Uses `CLAUDE_CODE_BIN=$HOME/.local/bin/claude-deepseek-v4`
  as an example, or another local Claude Code wrapper path configured by the
  operator.
- Uses a separate session file, for example `bot_sessions.claude.json`.
- Stores Claude conversation identity in `claude_session_id`.
- Uses a different `WEB_PORT` if the Web console is enabled.

## Configuration

The implementation will add optional configuration. Existing defaults remain
unchanged.

### Shared configuration keys

| Key | Default | Purpose |
| --- | --- | --- |
| `FEISHU_ENV_FILE` | `.env` | Env file loaded by `dotenv`. |
| `BOT_SESSION_FILE` | `bot_sessions.json` | Session file for the current bot process. |
| `CODEX_RUNTIME` | `exec-sdk` | Runtime selector. Adds `claude-code`. |

### Claude-specific configuration keys

| Key | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_CODE_BIN` | `claude` | Claude Code executable or wrapper command. |
| `CLAUDE_CODE_PERMISSION_MODE` | mapped from current policy | Claude Code permission mode. |
| `CLAUDE_CODE_EXTRA_ARGS` | empty | Optional extra CLI args, parsed as shell-style words. |

The minimal Claude env file can be:

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
BOT_SESSION_FILE=bot_sessions.claude.json
CODEX_WORKING_DIRECTORY=$HOME
WEB_PORT=3001
```

`CLAUDE_CODE_BIN` and `CODEX_WORKING_DIRECTORY` are local machine settings.
Each deployment must set them to paths that exist on that machine.

The Codex env file can keep its current shape and does not need
`CLAUDE_CODE_BIN`.

## Session data

`SessionRecord` will add a separate Claude field:

```ts
export type SessionRecord = {
    session_key: string;
    chat_id: string;
    sender_open_id: string;
    codex_thread_id?: string;
    claude_session_id?: string;
    model?: string;
    reasoning_effort?: string;
    first_message_id?: string;
    last_message_id?: string;
    title?: string;
    updated_at: string;
};
```

The runtime selects its identity field:

| Runtime | Read field | Write field |
| --- | --- | --- |
| `exec-sdk` | `codex_thread_id` | `codex_thread_id` |
| `app-server` | `codex_thread_id` | `codex_thread_id` |
| `claude-code` | `claude_session_id` | `claude_session_id` |

This separation prevents a Claude session ID from being used as a Codex thread
ID, and prevents a Codex thread ID from being passed to `claude --resume`.

## Claude Code runtime behavior

The new runtime will implement the existing `CodexRuntime` interface so the
rest of the bot can reuse the current queue and card renderer.

`runStreamed()` will start:

```bash
claude-deepseek-v4 \
  --print \
  --verbose \
  --output-format stream-json \
  --include-partial-messages
```

When a `claude_session_id` exists, the runtime adds:

```bash
--resume <claude_session_id>
```

The user message is written to stdin. The runtime reads stdout line by line and
maps Claude Code stream JSON into existing card events:

| Claude event | Bot event |
| --- | --- |
| `system.session_id` | update thread handle `id` |
| `stream_event.content_block_delta.text_delta` | `item.updated` with `agent_message` |
| `stream_event.content_block_start.tool_use` | `item.started` with a tool item |
| `stream_event.content_block_delta.input_json_delta` | aggregate tool input |
| `stream_event.content_block_stop` | `item.completed` for the tool item |
| `result.is_error=false` | `turn.completed` |
| `result.is_error=true` or non-zero exit with no text | `turn.failed` |

The runtime must not print secrets from stderr or tool input into logs without
passing through the existing redaction path.

## Feishu application independence

The two bot processes must not share Feishu credentials. This means:

- The Codex process uses the Codex Feishu app's App ID and App Secret.
- The Claude process uses the Claude Feishu app's App ID and App Secret.
- Each process has its own bot identifier values for group mention matching.
- Each Feishu application has its own event subscription and long connection
  configuration in the Feishu developer console.
- Each process has a different LaunchAgent label or service name.

The code will not support loading two Feishu credential sets into one process.
That would couple WebSocket clients, callback handling, runtime state, and
failure domains.

## Slash command behavior

Most existing slash commands remain local bot commands and work in both
processes.

Runtime-specific behavior:

- `/threads` remains available only when the runtime implements
  `listThreads()`. That currently means the Codex `app-server` runtime.
- In `claude-code`, `/threads` returns the existing unsupported-runtime message.
- `/mcp` still uses the configured Codex binary today. Supporting
  `claude mcp list` can be a separate change.

## File changes

The implementation is expected to touch only these files:

- `src/runtime.ts`
- `src/claudeCodeRuntime.ts`
- `src/session.ts`
- `src/index.ts`
- `package.json`
- `config/new-bot.env.template`
- `scripts/start-feishu2codex.sh`
- `tests/runtime.test.mjs`
- `tests/session.test.mjs`

If documentation is updated after implementation, keep it limited to this spec
or the README configuration section.

## Verification

The implementation is complete only when these checks pass:

1. `npm test`
2. `npx tsc --noEmit`
3. `npm run build`

The test coverage must include:

- Default runtime remains `exec-sdk`.
- `CODEX_RUNTIME=app-server` still selects `app-server`.
- `CODEX_RUNTIME=claude-code` selects `claude-code`.
- Existing string-form session records still normalize to `codex_thread_id`.
- Object-form records preserve both `codex_thread_id` and `claude_session_id`.
- A Claude stream JSON fixture maps text deltas to `agent_message`.
- A Claude `result` success maps to `turn.completed`.
- A Claude `session_id` updates the runtime handle id without changing
  `codex_thread_id`.

## Acceptance criteria

- Starting the Codex process with the existing `.env` does not require any new
  Claude configuration.
- Starting the Claude process with `FEISHU_ENV_FILE=.env.claude` connects to a
  different Feishu application.
- Codex and Claude session files are different files.
- Codex and Claude identity fields are different fields.
- Switching one process's runtime does not mutate the other process's session
  file.
- A failed Claude resume creates a new Claude session without deleting the
  existing Codex thread ID.
