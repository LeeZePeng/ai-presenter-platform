#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${AI_PRESENTER_PROJECT_DIR:-${0:A:h:h}}"
NODE_BIN="${AI_PRESENTER_NODE_BIN:-/Users/yshtola/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
ENV_FILE="${AI_PRESENTER_ENV_FILE:-$PROJECT_DIR/.env}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi
NODE_DIR="${NODE_BIN:h}"

cd "$PROJECT_DIR"
set -a
source "$ENV_FILE"
set +a
export PATH="$NODE_DIR:/Applications/ChatGPT.app/Contents/Resources:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec "$NODE_BIN" "$PROJECT_DIR/node_modules/tsx/dist/cli.mjs" server/index.ts
