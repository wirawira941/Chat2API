#!/data/data/com.termux/files/usr/bin/sh
# Chat2API headless launcher — modelled on ~/.9router/start-9router.sh.
#
# Why a launcher instead of `node main.cjs`:
#   * Android's OOM killer punishes Node's default heap on a phone, so the heap
#     is capped hard (the dashboard needs far less than the 4 GB default).
#   * `setsid` + `nohup` detach the server from the terminal so it survives the
#     Termux session closing, and `run` mode restarts it if it dies.
#   * Everything is one bundled file, so there is no node_modules to load.
#
# Usage:
#   ./launcher.sh start    # start in background (idempotent)
#   ./launcher.sh stop
#   ./launcher.sh restart
#   ./launcher.sh status
#   ./launcher.sh logs
#   ./launcher.sh run      # foreground with auto-restart (use with tmux/termux-services)
set -u

HOME_DIR=${HOME:-/data/data/com.termux/files/home}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENTRY="$APP_DIR/headless-dist/main.cjs"
if [ ! -f "$ENTRY" ] && [ -f "$APP_DIR/main.cjs" ]; then
  ENTRY="$APP_DIR/main.cjs"
fi

# Data (config, accounts, logs) — override with CHAT2API_USER_DATA.
export CHAT2API_HOME="${CHAT2API_HOME:-$APP_DIR}"
export CHAT2API_USER_DATA="${CHAT2API_USER_DATA:-$HOME_DIR/.chat2api-web}"
export CHAT2API_WEB_PORT="${CHAT2API_WEB_PORT:-3000}"
export CHAT2API_WEB_HOST="${CHAT2API_WEB_HOST:-127.0.0.1}"

# Keep the proxy on loopback too unless the operator opts in.
export CHAT2API_PROXY_HOST="${CHAT2API_PROXY_HOST:-127.0.0.1}"

LOG_DIR="$CHAT2API_USER_DATA/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$CHAT2API_USER_DATA/server.pid"
mkdir -p "$LOG_DIR"

# 256 MB is comfortable for Koa + the dashboard; the OOM killer is not.
NODE_OPTS="--max-old-space-size=${CHAT2API_HEAP_MB:-256} --max-semi-space-size=16"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_ready() {
  i=0
  while [ "$i" -lt 60 ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:$CHAT2API_WEB_PORT/api/health" >/dev/null 2>&1 && return 0
    else
      node -e "
        const net=require('net');
        const s=net.connect($CHAT2API_WEB_PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});
        s.on('error',()=>process.exit(1));
      " >/dev/null 2>&1 && return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE")) on port $CHAT2API_WEB_PORT"
    return 0
  fi
  if [ ! -f "$ENTRY" ]; then
    echo "missing $ENTRY — build it first: npm run build:headless" >&2
    return 1
  fi

  cd "$APP_DIR" || exit 1
  # shellcheck disable=SC2086
  setsid env NODE_OPTIONS="$NODE_OPTS" nohup node "$ENTRY" \
    >>"$LOG_FILE" 2>&1 </dev/null &

  echo $! >"$PID_FILE"

  if wait_ready; then
    echo "Chat2API running: http://127.0.0.1:$CHAT2API_WEB_PORT  (pid $(cat "$PID_FILE"))"
    echo "logs: $LOG_FILE"
  else
    echo "failed to start within 30s — last log lines:" >&2
    tail -20 "$LOG_FILE" >&2
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null
  i=0
  while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null
  rm -f "$PID_FILE"
  echo "stopped"
}

run_forever() {
  cd "$APP_DIR" || exit 1
  echo "running in foreground (ctrl-c to stop) — http://127.0.0.1:$CHAT2API_WEB_PORT"
  while :; do
    # shellcheck disable=SC2086
    NODE_OPTIONS="$NODE_OPTS" node "$ENTRY" >>"$LOG_FILE" 2>&1
    code=$?
    echo "$(date '+%F %T') exited ($code), restarting in 3s" >>"$LOG_FILE"
    sleep 3
  done
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  run) run_forever ;;
  status)
    if is_running; then
      echo "running (pid $(cat "$PID_FILE")) on port $CHAT2API_WEB_PORT"
    else
      echo "stopped"
    fi
    ;;
  logs) tail -f "$LOG_FILE" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|run}" >&2
    exit 2
    ;;
esac
