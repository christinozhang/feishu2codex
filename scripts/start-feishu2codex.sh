#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo "Missing .env. Copy config/new-bot.env.template to .env and fill FEISHU_APP_ID / FEISHU_APP_SECRET." >&2
  exit 1
fi
npm run build
exec npm start
