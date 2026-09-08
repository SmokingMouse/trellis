#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
OUT=${AS_ADOPT_OUT:-$ROOT/out/mobile-as-adopt}
LOCK_DIR=/tmp/trellis-mobile-verify.lock
OWN_LOCK=0
H=
SERVER_PID=
DAEMON_PID=
SESSION=mv-as-adopt-$$
BASE=http://127.0.0.1:3479
ab() { AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  status=$?
  trap - 0 1 2 15
  if [ "$OWN_LOCK" = 1 ]; then
    ab close >/dev/null 2>&1 || true
    for pid in "$SERVER_PID" "$DAEMON_PID"; do [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; done
    for pid in "$SERVER_PID" "$DAEMON_PID"; do [ -z "$pid" ] || wait "$pid" 2>/dev/null || true; done
    if [ -n "$H" ]; then cp "$H"/*.log "$H"/*.json "$OUT/" 2>/dev/null || true; rm -rf "$H"; fi
    rm -f "$LOCK_DIR/owner"; rmdir "$LOCK_DIR"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
for tool in bun agent-browser curl lsof sqlite3; do command -v "$tool" >/dev/null || fail "missing $tool"; done
tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do tries=$((tries+1)); [ "$tries" -lt 180 ] || fail 'lock timeout'; sleep 5; done
OWN_LOCK=1
echo "$$ mobile-as-adopt" > "$LOCK_DIR/owner"
mkdir -p "$OUT"
for port in 3479 3480; do lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && fail "port $port in use"; done
H=$(mktemp -d /tmp/trellis-as-adopt-XXXXXX)
export no_proxy='*' http_proxy='' https_proxy='' ALL_PROXY=''
export TRELLIS_DB_PATH="$H/trellis.db" TRELLIS_LARK=off TRELLIS_AS=on TRELLIS_AS_PROJECT=off TRELLIS_AS_ADOPT=on
export TRELLIS_AS_SOCKET="$H/as.sock" TRELLIS_AS_TOKEN_PATH="$H/.agent-server/token"
export TRELLIS_AUTH_PASS=as-adopt-pass TRELLIS_AUTH_TOKEN=as-adopt-token
if [ -n "${TRELLIS_VERIFY_SOURCE_DB:-}" ]; then
  [ -f "$TRELLIS_VERIFY_SOURCE_DB" ] || fail 'source database missing'
  sqlite3 "$TRELLIS_VERIFY_SOURCE_DB" ".backup '$TRELLIS_DB_PATH'"
fi
wait_file() { tries=0; until [ -s "$1" ]; do tries=$((tries+1)); [ "$tries" -lt 90 ] || fail "missing $1"; sleep 1; done; }
ready() { tries=0; until curl --noproxy '*' -fsS "$BASE/login" >/dev/null 2>&1; do tries=$((tries+1)); [ "$tries" -lt 90 ] || fail readiness; sleep 1; done; }
wait_js() { label=$1; expression=$2; tries=0; until ab eval "$expression" 2>/dev/null | grep -q '^true$'; do tries=$((tries+1)); if [ "$tries" -ge 60 ]; then ab snapshot || true; ab errors || true; ab screenshot "$OUT/failure.png" || true; fail "$label"; fi; sleep 1; done; echo "PASS: $label"; }
bun --bun run build > "$H/build.log" 2>&1 || { tail -60 "$H/build.log"; fail build; }
HOME="$H" bun scripts/mobile-verify/as-adopt-fixture.ts "$H" > "$H/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_file "$H/ready"
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p 3479 -H 127.0.0.1 > "$H/server.log" 2>&1 &
SERVER_PID=$!
ready
bun scripts/mobile-verify/as-adopt-proof.ts "$H" main
SID=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).sid)' "$H/proof.json")
NODE=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).nodeId)' "$H/proof.json")
ab open "$BASE/login"
ab set viewport 390 844
ab snapshot -i
ab fill '#pw' as-adopt-pass
ab click 'button[type="submit"]'
ab open "$BASE/?session=$SID&node=$NODE"
wait_js 'adopted conversation rendered in home' "Boolean(document.querySelector('[data-as-project=\"$NODE\"]')) && document.body.innerText.includes('外部线程回复') && document.body.innerText.includes('外部会话')"
ab screenshot "$OUT/mobile-as-adopt.png"
ab close
# Restart against the same database: identities and turn counts must survive.
sqlite3 "$TRELLIS_DB_PATH" 'SELECT thread_id,session_id FROM as_adoptions ORDER BY thread_id' > "$H/identities-before.txt"
kill "$SERVER_PID"; wait "$SERVER_PID" || true; SERVER_PID=
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p 3479 -H 127.0.0.1 > "$H/server-restart.log" 2>&1 &
SERVER_PID=$!
ready
sleep 3
sqlite3 "$TRELLIS_DB_PATH" 'SELECT thread_id,session_id FROM as_adoptions ORDER BY thread_id' > "$H/identities-after.txt"
cmp "$H/identities-before.txt" "$H/identities-after.txt" || fail 'restart identity changed'
bun scripts/mobile-verify/as-adopt-proof.ts "$H" delete
kill "$SERVER_PID"; wait "$SERVER_PID" || true; SERVER_PID=
export TRELLIS_AS_ADOPT=off
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p 3479 -H 127.0.0.1 > "$H/server-off.log" 2>&1 &
SERVER_PID=$!
ready
bun scripts/mobile-verify/as-adopt-proof.ts "$H" off
echo 'PASS: AS adoption E2E'
