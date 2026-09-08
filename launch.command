#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo '请先运行 setup-voice.command，准备本机中文听说。'
  read -r answer
  exit 1
fi
.venv/bin/python server.py --open "$@"
