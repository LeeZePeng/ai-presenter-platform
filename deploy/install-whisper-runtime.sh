#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_dir=${AI_PRESENTER_PROJECT_DIR:-$(cd "$script_dir/.." && pwd)}
platform=$(uname -s)
if [[ $platform == Darwin ]]; then
  runtime_dir=${WHISPER_RUNTIME_DIR:-$project_dir/runtime/whisper}
else
  if [[ ${EUID} -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
  runtime_dir=${WHISPER_RUNTIME_DIR:-/var/lib/ai-presenter/runtime/whisper}
fi
version=${WHISPER_CPP_VERSION:-v1.7.6}
model_name=${WHISPER_MODEL_NAME:-ggml-small.bin}
model_sha256=${WHISPER_MODEL_SHA256:-1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b}
model_url=${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model_name}}
build_root=$(mktemp -d)
trap 'rm -rf "$build_root"' EXIT

if [[ $platform == Darwin ]]; then
  python_bin=${PYTHON_BIN:-python3}
  cmake_bin=${CMAKE_BIN:-$project_dir/runtime/python-tools/bin/cmake}
  if [[ ! -x $cmake_bin ]]; then
    "$python_bin" -m venv "$project_dir/runtime/python-tools"
    "$project_dir/runtime/python-tools/bin/pip" install --disable-pip-version-check 'cmake==3.31.6'
  fi
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y build-essential cmake curl git
  cmake_bin=$(command -v cmake)
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y cmake gcc gcc-c++ git make curl
  cmake_bin=$(command -v cmake)
else
  echo "Unsupported Linux distribution" >&2
  exit 1
fi

git clone --depth 1 --branch "$version" https://github.com/ggerganov/whisper.cpp.git "$build_root/whisper.cpp"
"$cmake_bin" -S "$build_root/whisper.cpp" -B "$build_root/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
if [[ $platform == Darwin ]]; then
  build_jobs=$(sysctl -n hw.logicalcpu)
else
  build_jobs=$(nproc)
fi
"$cmake_bin" --build "$build_root/whisper.cpp/build" --config Release -j "$build_jobs"

if [[ $platform == Darwin ]]; then
  install -d "$runtime_dir"
  install -m 755 "$build_root/whisper.cpp/build/bin/whisper-cli" "$runtime_dir/whisper-cli"
else
  install -d -o presenter -g presenter "$runtime_dir"
  install -m 755 "$build_root/whisper.cpp/build/bin/whisper-cli" "$runtime_dir/whisper-cli"
fi

model_target="$runtime_dir/$model_name"
if [[ -n ${WHISPER_MODEL_SOURCE:-} ]]; then
  install -m 644 "$WHISPER_MODEL_SOURCE" "$model_target"
elif [[ ! -f $model_target ]]; then
  curl -fL --retry 4 --retry-delay 3 "$model_url" -o "$model_target.part"
  mv "$model_target.part" "$model_target"
fi

if [[ $platform == Darwin ]]; then
  actual_sha256=$(shasum -a 256 "$model_target" | awk '{print $1}')
else
  actual_sha256=$(sha256sum "$model_target" | awk '{print $1}')
fi
if [[ $actual_sha256 != "$model_sha256" ]]; then
  echo "Whisper model checksum mismatch: $actual_sha256" >&2
  exit 1
fi
if [[ $platform == Darwin ]]; then
  "$runtime_dir/whisper-cli" --help >/dev/null
else
  chown -R presenter:presenter "$runtime_dir"
  runuser -u presenter -- bash -c "cd '$runtime_dir' && ./whisper-cli --help >/dev/null"
fi
echo "Whisper runtime installed at $runtime_dir"
