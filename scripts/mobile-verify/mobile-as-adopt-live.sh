#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
OUT=${AS_ADOPT_LIVE_OUT:-$ROOT/out/mobile-as-adopt-live}
LOCK_DIR=/tmp/trellis-mobile-verify.lock
OWN_LOCK=0
H=
SCRATCH=
SERVER_PID=
USER_HOME=$HOME
cleanup() {
  status=$?
  trap - 0 1 2 15
  if [ "$OWN_LOCK" = 1 ]; then
    [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
    [ -z "$SERVER_PID" ] || wait "$SERVER_PID" 2>/dev/null || true
    if [ -n "$H" ] && [ -s "$H/live-proof.json" ]; then
      bun scripts/mobile-verify/as-adopt-live-proof.ts "$H" close >> "$OUT/close.log" 2>&1 || status=1
    fi
    if [ -n "$H" ]; then cp "$H"/*.log "$H"/*.json "$H"/*.sse "$OUT/" 2>/dev/null || true; rm -rf "$H"; fi
    [ -z "$SCRATCH" ] || rmdir "$SCRATCH" 2>/dev/null || true
    rm -f "$LOCK_DIR/owner"; rmdir "$LOCK_DIR"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do tries=$((tries+1)); [ "$tries" -lt 180 ] || exit 1; sleep 5; done
OWN_LOCK=1
echo "$$ mobile-as-adopt-live" > "$LOCK_DIR/owner"
mkdir -p "$OUT" "$USER_HOME/.trellis/scratch"
lsof -nP -iTCP:3479 -sTCP:LISTEN >/dev/null 2>&1 && exit 1
H=$(mktemp -d /tmp/trellis-as-adopt-live-XXXXXX)
SCRATCH=$(mktemp -d "$USER_HOME/.trellis/scratch/as-adopt-proof-XXXXXX")
export TRELLIS_DB_PATH="$H/trellis.db" TRELLIS_AS=on TRELLIS_AS_PROJECT=off TRELLIS_AS_ADOPT=on
export TRELLIS_AS_SOCKET="$USER_HOME/.sm-toolkit/agent-server.sock" TRELLIS_AS_TOKEN_PATH="$USER_HOME/.agent-server/token"
export TRELLIS_AUTH_PASS=as-adopt-pass TRELLIS_AUTH_TOKEN=as-adopt-token
export TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off
export no_proxy='*' http_proxy='' https_proxy='' ALL_PROXY=''
sqlite3 "${TRELLIS_VERIFY_SOURCE_DB:-$USER_HOME/.trellis/data.db}" ".backup '$TRELLIS_DB_PATH'"
bun --bun run build > "$H/build.log" 2>&1
bun scripts/mobile-verify/as-adopt-live-proof.ts "$H" prepare "$SCRATCH"
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p 3479 -H 127.0.0.1 > "$H/server.log" 2>&1 &
SERVER_PID=$!
tries=0
until curl --noproxy '*' -fsS http://127.0.0.1:3479/login >/dev/null 2>&1; do tries=$((tries+1)); [ "$tries" -lt 90 ] || exit 1; sleep 1; done
bun scripts/mobile-verify/as-adopt-live-proof.ts "$H" verify
