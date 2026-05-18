# AGENTS.md

## Language

Answer in Chinese for work in this repository.

## Project purpose

This repository contains a TypeScript Feishu-to-Codex bot. It receives Feishu
messages through the Feishu long connection, runs Codex through
`@openai/codex-sdk`, and renders the result as Feishu interactive cards.

## Safety rules

- Do not print `.env` values that contain credentials.
- Do not paste `FEISHU_APP_SECRET`, tokens, cookies, passwords, or
  Authorization headers into chat.
- Preserve `.env` during migration or rebuild work.
- Keep runtime files such as `bot_sessions.json`, `logs/`, and `dist/` out of
  commits.
- Do not change deployment-specific service files unless the task explicitly
  asks for deployment changes.

## Code rules

- Keep implementation changes local to the relevant module.
- Use `apply_patch` for manual source edits.
- Use `rg` for code searches.
- Do not refactor unrelated files while changing bot behavior.
- Keep card output redacted through `src/streaming.ts`.
- Keep slash command logic in `src/slash.ts`.
- Keep approval rules in `src/approval.ts`.
- Keep session compatibility in `src/session.ts`.

## Verification

Run these checks after code changes:

```bash
npm test
npx tsc --noEmit
npm run build
```

If `graphify` is available and code files changed, refresh the graph:

```bash
graphify update .
```

## Feishu behavior

- Normal messages run without Feishu approval.
- High-risk messages require Feishu approval before Codex starts.
- `Approve` runs with the privileged Codex policy.
- `Deny` or timeout leaves Codex unstarted.
- `/help`, `/skills`, `/mcp`, `/approval`, `/reset`, and `/status` are handled
  locally by the bot.

## Markdown and card behavior

`src/streaming.ts` renders Feishu interactive cards. The response section uses
Feishu `markdown` elements. Timeline details remain escaped so command output
does not break the card.
