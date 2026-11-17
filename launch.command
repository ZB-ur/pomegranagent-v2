#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ -x .runtime/python/bin/python3.12 ]; then
  export PYTHONPATH="$PWD/.runtime/app-packages"
  export PYTHONNOUSERSITE=1
  exec .runtime/python/bin/python3.12 server.py --open "$@"
fi
if [ ! -x .venv/bin/python ]; then
  ./setup-voice.command --no-pause || exit 1
elif ! .venv/bin/python scripts/setup_voice.py --check; then
  ./setup-voice.command --no-pause || exit 1
fi
exec .venv/bin/python server.py --open "$@"
