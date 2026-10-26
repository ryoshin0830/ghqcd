#!/bin/sh
# Every inference step runs with outbound network denied by the OS sandbox.
set -eu
NONET='(version 1)(allow default)(deny network*)'
PY=.venv/bin/python
sandbox-exec -p "$NONET" $PY -c 'import socket; socket.create_connection(("huggingface.co", 443), 5)' 2>/dev/null \
  && { echo "network NOT blocked" >&2; exit 1; } || echo "network blocked: ok" >&2
sandbox-exec -p "$NONET" $PY lexical.py
for m in e5-small qwen3-0.6b gemma2 bge-m3; do sandbox-exec -p "$NONET" $PY run.py "$m"; done
for m in e5-small qwen3-0.6b gemma2 bge-m3; do
  for i in 1 2 3; do sandbox-exec -p "$NONET" $PY run.py "$m" --cold | sed "s/^/{\"model\":\"$m\",\"run\":$i,\"r\":/;s/\$/}/"; done
done > results/cold.jsonl
