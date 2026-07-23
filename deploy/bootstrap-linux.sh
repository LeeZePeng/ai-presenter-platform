#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y build-essential ca-certificates cmake curl ffmpeg git nginx python3 rsync tar xz-utils
  install_node() {
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  }
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ca-certificates cmake curl gcc gcc-c++ git make nginx python3 rsync tar xz
  install_node() {
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  }
  if ! command -v ffmpeg >/dev/null 2>&1; then
    dnf install -y https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-8.noarch.rpm
    dnf install -y ffmpeg
  fi
else
  echo "Unsupported Linux distribution: apt-get or dnf is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 22 ]]; then
  install_node
fi

if [[ $(free -m | awk '/^Mem:/ {print $2}') -lt 3500 ]] && [[ $(free -m | awk '/^Swap:/ {print $2}') -eq 0 ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

npm install -g @openai/codex@0.93.0
ln -sfn "$(command -v codex)" /usr/local/bin/codex-chat

if ! id presenter >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/ai-presenter --shell /bin/bash presenter
fi

install -d -o presenter -g presenter /opt/ai-presenter-platform
install -d -o presenter -g presenter /var/lib/ai-presenter/data
install -d -o presenter -g presenter /var/lib/ai-presenter/.codex/skills

echo "Server prerequisites installed. Deploy files, environment, Codex config, and skill next."
