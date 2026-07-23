#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

runtime_dir=${WHISPER_RUNTIME_DIR:-/var/lib/ai-presenter/runtime/whisper}
version=${WHISPER_CPP_VERSION:-v1.7.6}
model_name=${WHISPER_MODEL_NAME:-ggml-small.bin}
model_sha256=${WHISPER_MODEL_SHA256:-1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b}
model_url=${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model_name}}
build_root=$(mktemp -d)
trap 'rm -rf "$build_root"' EXIT

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y build-essential cmake curl git
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y cmake gcc gcc-c++ git make curl
else
  echo "Unsupported Linux distribution" >&2
  exit 1
fi

git clone --depth 1 --branch "$version" https://github.com/ggerganov/whisper.cpp.git "$build_root/whisper.cpp"
cmake -S "$build_root/whisper.cpp" -B "$build_root/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "$build_root/whisper.cpp/build" --config Release -j "$(nproc)"

install -d -o presenter -g presenter "$runtime_dir"
install -m 755 "$build_root/whisper.cpp/build/bin/whisper-cli" "$runtime_dir/whisper-cli"

model_target="$runtime_dir/$model_name"
if [[ -n ${WHISPER_MODEL_SOURCE:-} ]]; then
  install -m 644 "$WHISPER_MODEL_SOURCE" "$model_target"
elif [[ ! -f $model_target ]]; then
  curl -fL --retry 4 --retry-delay 3 "$model_url" -o "$model_target.part"
  mv "$model_target.part" "$model_target"
fi

actual_sha256=$(sha256sum "$model_target" | awk '{print $1}')
if [[ $actual_sha256 != "$model_sha256" ]]; then
  echo "Whisper model checksum mismatch: $actual_sha256" >&2
  exit 1
fi
chown -R presenter:presenter "$runtime_dir"
runuser -u presenter -- bash -c "cd '$runtime_dir' && ./whisper-cli --help >/dev/null"
echo "Whisper runtime installed at $runtime_dir"
