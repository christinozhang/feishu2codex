#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${FEISHU_ENV_FILE:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Copy config/new-bot.env.template and fill FEISHU_APP_ID / FEISHU_APP_SECRET." >&2
  exit 1
fi
npm run build
exec npm start
