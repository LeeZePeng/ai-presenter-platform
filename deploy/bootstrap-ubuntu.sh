#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl ffmpeg nginx rsync git

if ! command -v node >/dev/null 2>&1 || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

npm install -g @openai/codex

if ! id presenter >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/ai-presenter --shell /bin/bash presenter
fi

install -d -o presenter -g presenter /opt/ai-presenter-platform
install -d -o presenter -g presenter /var/lib/ai-presenter/data
install -d -o presenter -g presenter /var/lib/ai-presenter/.codex/skills

echo "Server prerequisites installed. Deploy files, environment, Codex config, and skill next."
