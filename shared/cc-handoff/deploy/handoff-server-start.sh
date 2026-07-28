#!/usr/bin/env bash
# ── handoff-server-start.sh — 启动 Handoff Server ──
set -euo pipefail
DIR=~/handoff-server
DATA_DIR=$DIR/data
PORT=${PORT:-8377}
PIDFILE=/tmp/handoff-server.pid

mkdir -p "$DATA_DIR"
pkill -f "handoff-server.py" 2>/dev/null || true
sleep 1

nohup env HANDOFF_STORE=db HANDOFF_DIR="$DATA_DIR" PORT="$PORT" \
  python3 "$DIR/handoff-server.py" > "$DIR/server.log" 2>&1 &

PID=$!
echo $PID > "$PIDFILE"
echo "Started PID=$PID on port $PORT (db mode)"
