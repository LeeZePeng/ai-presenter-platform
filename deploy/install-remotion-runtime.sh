#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
runtime_root=${REMOTION_RUNTIME_ROOT:-/var/lib/ai-presenter/runtime/remotion-4.0.490}
font_root=${REMOTION_FONT_ROOT:-/var/lib/ai-presenter/runtime/fonts}

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y \
    chromium fonts-noto-cjk python3 python3-venv libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libgbm1 libxcomposite1 libxdamage1 libxrandr2
  browser_executable=$(command -v chromium)
  system_font_root=/usr/share/fonts/opentype/noto
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y \
    atk at-spi2-atk at-spi2-core chromium-headless google-noto-sans-cjk-ttc-fonts python3 \
    libXcomposite libXdamage libXrandr mesa-libgbm
  browser_executable=/usr/lib64/chromium-browser/headless_shell
  system_font_root=/usr/share/fonts/google-noto-cjk
else
  echo "Unsupported Linux distribution" >&2
  exit 1
fi

for weight in Regular Bold Black; do
  test -s "$system_font_root/NotoSansCJK-$weight.ttc"
done

font_tools="$font_root/fonttools"
install -d -o presenter -g presenter "$font_root"
python3 -m venv "$font_tools"
"$font_tools/bin/pip" install --disable-pip-version-check --quiet 'fonttools==4.27.1'
"$font_tools/bin/python" - "$system_font_root" "$font_root" <<'PY'
import pathlib
import sys
from fontTools.ttLib import TTCollection

source_root = pathlib.Path(sys.argv[1])
output_root = pathlib.Path(sys.argv[2])
for weight in ('Regular', 'Bold', 'Black'):
    output = output_root / f'NotoSansCJKSC-{weight}.otf'
    collection = TTCollection(source_root / f'NotoSansCJK-{weight}.ttc')
    collection.fonts[2].save(output)
PY
chown presenter:presenter "$font_root"/NotoSansCJKSC-*.otf
chmod 644 "$font_root"/NotoSansCJKSC-*.otf

install -d -o presenter -g presenter "$runtime_root"
install -m 644 -o presenter -g presenter "$script_dir/remotion-runtime/package.json" "$runtime_root/package.json"
install -m 644 -o presenter -g presenter "$script_dir/remotion-runtime/package-lock.json" "$runtime_root/package-lock.json"
install -m 644 -o presenter -g presenter "$script_dir/remotion-runtime/smoke.tsx" "$runtime_root/smoke.tsx"
install -d -o presenter -g presenter "$runtime_root/public/fonts"
for weight in Regular Bold Black; do
  install -m 644 -o presenter -g presenter \
    "$font_root/NotoSansCJKSC-$weight.otf" \
    "$runtime_root/public/fonts/NotoSansCJKSC-$weight.otf"
done
sudo -u presenter npm ci --prefix "$runtime_root" --omit=dev
ln -sfn "$runtime_root" /var/lib/ai-presenter/runtime/remotion
chown -h presenter:presenter /var/lib/ai-presenter/runtime/remotion

test -x "$runtime_root/node_modules/.bin/remotion"
test -x "$browser_executable"
fc-match "Noto Sans CJK SC" | head -1
(
  cd "$runtime_root"
  sudo -u presenter ./node_modules/.bin/remotion still \
    smoke.tsx RuntimeSmoke smoke.png \
    --browser-executable="$browser_executable" --overwrite --log=error
)
test -s "$runtime_root/smoke.png"
echo "Remotion runtime: /var/lib/ai-presenter/runtime/remotion"
echo "Browser executable: $browser_executable"
