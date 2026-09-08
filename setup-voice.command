#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  if command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv .venv || exit 1
  elif command -v uv >/dev/null 2>&1; then
    UV_PYTHON_INSTALL_DIR="$PWD/.runtime/python" UV_CACHE_DIR="$PWD/.runtime/cache" uv venv --python 3.12 .venv || exit 1
  else
    echo '请先从 python.org 安装 Python 3.12，再运行本文件。'
    read -r answer
    exit 1
  fi
fi
UV_CACHE_DIR="$PWD/.runtime/cache" .venv/bin/python scripts/setup_voice.py
result=$?
if [ "$result" -eq 0 ]; then echo '准备完成。打开 launch.command 即可开始。'; fi
read -r answer
exit "$result"
