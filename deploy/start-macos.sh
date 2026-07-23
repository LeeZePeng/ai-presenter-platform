#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${AI_PRESENTER_PROJECT_DIR:-${0:A:h:h}}"
NODE_BIN="${AI_PRESENTER_NODE_BIN:-/Users/yshtola/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
ENV_FILE="${AI_PRESENTER_ENV_FILE:-$PROJECT_DIR/.env}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi
NODE_DIR="${NODE_BIN:h}"
set -a
source "$ENV_FILE"
set +a
mkdir -p "$PROJECT_DIR/bin"
if [[ ! -x "$PROJECT_DIR/bin/ffprobe" ]]; then
  FFPROBE_SOURCE=$(cd "$PROJECT_DIR" && "$NODE_BIN" -e "process.stdout.write(require('@ffprobe-installer/ffprobe').path)")
  ln -sfn "$FFPROBE_SOURCE" "$PROJECT_DIR/bin/ffprobe"
fi
if [[ ! -x "$PROJECT_DIR/bin/ffmpeg" ]]; then
  FFMPEG_SOURCE=$(cd "$PROJECT_DIR" && "$NODE_BIN" -e "process.stdout.write(require('ffmpeg-static'))")
  ln -sfn "$FFMPEG_SOURCE" "$PROJECT_DIR/bin/ffmpeg"
fi
FONT_DIR="$PROJECT_DIR/deploy/remotion-runtime/public/fonts"
mkdir -p "$FONT_DIR"
if [[ -L "$FONT_DIR/NotoSansCJKSC-Regular.otf" || ! -s "$FONT_DIR/NotoSansCJKSC-Regular.otf" ]]; then
  cp -f "$CJK_FONT_REGULAR_PATH" "$FONT_DIR/NotoSansCJKSC-Regular.otf"
fi
if [[ -L "$FONT_DIR/NotoSansCJKSC-Bold.otf" || ! -s "$FONT_DIR/NotoSansCJKSC-Bold.otf" ]]; then
  cp -f "$CJK_FONT_BOLD_PATH" "$FONT_DIR/NotoSansCJKSC-Bold.otf"
fi
if [[ -L "$FONT_DIR/NotoSansCJKSC-Black.otf" || ! -s "$FONT_DIR/NotoSansCJKSC-Black.otf" ]]; then
  cp -f "$CJK_FONT_BLACK_PATH" "$FONT_DIR/NotoSansCJKSC-Black.otf"
fi

cd "$PROJECT_DIR"
export PATH="$PROJECT_DIR/bin:$NODE_DIR:/Applications/ChatGPT.app/Contents/Resources:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec "$NODE_BIN" "$PROJECT_DIR/node_modules/tsx/dist/cli.mjs" server/index.ts
