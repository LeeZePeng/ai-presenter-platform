#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  x86_64|amd64) asset="yt-dlp_linux" ;;
  aarch64|arm64) asset="yt-dlp_linux_aarch64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

release_url="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

curl -fL "$release_url/$asset" -o "$work_dir/$asset"
curl -fL "$release_url/SHA2-256SUMS" -o "$work_dir/SHA2-256SUMS"

expected="$(awk -v name="$asset" '$2 == name {print $1}' "$work_dir/SHA2-256SUMS")"
if [[ -z "$expected" ]]; then
  echo "Checksum entry not found for $asset" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work_dir/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$work_dir/$asset" | awk '{print $1}')"
fi

if [[ "$actual" != "$expected" ]]; then
  echo "Checksum mismatch for $asset" >&2
  exit 1
fi

install -m 0755 "$work_dir/$asset" /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version
