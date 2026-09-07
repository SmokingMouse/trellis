#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
OUT=${AS_SHADOW_OUT:-/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-as-migrate-1-fix-31ae/out}
LOCK_DIR=/tmp/trellis-mobile-verify.lock
OWN_LOCK=0
H=
SERVER_PID=
DAEMON_PID=
SESSION=mv-as-shadow-$$
PORT=3477
BASE=http://127.0.0.1:$PORT
ab() { AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"; }
cleanup() {
  status=$?
  trap - 0 1 2 15
  if [ "$OWN_LOCK" = 1 ]; then
    ab close >/dev/null 2>&1 || true
    for pid in "$SERVER_PID" "$DAEMON_PID"; do
      if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done
    for pid in "$SERVER_PID" "$DAEMON_PID"; do
      if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
    done
    if [ -n "$H" ]; then
      cp "$H"/*.log "$OUT/" 2>/dev/null || true
      rm -rf "$H"
    fi
    rm -f "$LOCK_DIR/owner"
    rmdir "$LOCK_DIR"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
fail() { echo "FAIL: $*" >&2; exit 1; }
for tool in bun agent-browser curl lsof; do command -v "$tool" >/dev/null || fail "missing $tool"; done
tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  tries=$((tries + 1)); [ "$tries" -lt 180 ] || fail "mobile verify lock timeout"
  sleep 5
done
OWN_LOCK=1
echo "$$ mobile-as-shadow" > "$LOCK_DIR/owner"
mkdir -p "$OUT"
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT already in use"
H=$(mktemp -d /tmp/trellis-as-shadow-XXXXXX)
export no_proxy='*' http_proxy='' https_proxy='' ALL_PROXY=''
export TRELLIS_DB_PATH="$H/trellis.db" TRELLIS_LARK=off
export TRELLIS_AS_SOCKET="$H/as.sock" TRELLIS_AS_TOKEN_PATH="$H/.agent-server/token"
export TRELLIS_AUTH_PASS=as-shadow-pass TRELLIS_AUTH_TOKEN=as-shadow-token

wait_file() {
  tries=0
  until [ -f "$1" ]; do
    tries=$((tries + 1)); [ "$tries" -lt 90 ] || fail "missing $1"
    sleep 1
  done
}
wait_js() {
  label=$1; expression=$2; tries=0
  until ab eval "$expression" 2>/dev/null | grep -q '^true$'; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then ab snapshot || true; fail "$label"; fi
    sleep 1
  done
  echo "PASS: $label"
}

# Build under the original HOME so the existing Turbopack root includes this worktree.
# All mutable runtime state is isolated even if instrumentation runs during build.
echo '== build =='
bun --bun run build > "$H/build.log" 2>&1 || { tail -60 "$H/build.log"; fail build; }
HOME="$H" bun scripts/mobile-verify/as-shadow-fixture.ts "$H" > "$H/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_file "$H/thread-id"
THREAD_ID=$(cat "$H/thread-id")
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 > "$H/server.log" 2>&1 &
SERVER_PID=$!
tries=0
until curl --noproxy '*' -fsS --max-time 2 "$BASE/login" >/dev/null 2>&1; do
  tries=$((tries + 1)); [ "$tries" -lt 90 ] || fail 'server readiness'
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -60 "$H/server.log"; fail 'server exited'; }
  sleep 1
done
for path in /api/as/threads "/api/as/threads/$THREAD_ID/stream"; do
  code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$BASE$path")
  [ "$code" = 401 ] || fail "auth gate $path returned $code"
done
echo 'PASS: both API routes require authentication'
code=$(curl --noproxy '*' -s -b trellis_auth=as-shadow-token -o /dev/null -w '%{http_code}' "$BASE/api/as/threads/$THREAD_ID/stream?sinceSeq=-1")
[ "$code" = 400 ] || fail "invalid cursor returned $code"
code=$(curl --noproxy '*' -s -b trellis_auth=as-shadow-token -o /dev/null -w '%{http_code}' "$BASE/api/as/threads/missing/stream")
[ "$code" = 404 ] || fail "missing thread returned $code"

ab set device 'iPhone 15'
ab set viewport 390 844
ab open "$BASE/console/threads"
wait_js 'page auth gate' "location.pathname === '/login' && Boolean(document.querySelector('#pw'))"
ab fill '#pw' as-shadow-pass
ab click 'button[type="submit"]'
ab open "$BASE/console/threads"
wait_js 'daemon thread listed' "Boolean(document.querySelector('[data-as-thread=\"$THREAD_ID\"]'))"
ab click "[data-as-thread=\"$THREAD_ID\"]"
wait_js 'observer connected' "document.querySelector('[data-as-log]')?.textContent.includes('实时连接') === true"
touch "$H/start"
wait_js 'read-only pending approval visible' "Boolean(document.querySelector('[data-as-approval]')) && Boolean(document.querySelector('[data-as-item=thought]'))"
ab screenshot "$OUT/mobile-as-approval.png"
touch "$H/approve"
wait_js 'live delta before completion' "document.querySelector('[data-as-item=answer] pre')?.textContent === '实时片段已到达。' && document.querySelector('[data-as-item=answer]')?.dataset.itemStatus === 'inProgress' && !document.querySelector('[data-as-approval]')"
ab screenshot "$OUT/mobile-as-live.png"
wait_js 'P2-3 initially follows live tail' "(() => { const main = document.querySelector('.as-shadow'); return main.scrollHeight - main.clientHeight - main.scrollTop < 50; })()"
ab eval "(() => { const main = document.querySelector('.as-shadow'); main.scrollTop -= 160; sessionStorage.setItem('as-scrolled-up', String(main.scrollTop)); return true; })()"
wait_js 'P2-3 scrolling up disables following' "document.querySelector('[data-as-log]')?.dataset.followTail === 'false' && Boolean(document.querySelector('[data-as-follow]'))"
touch "$H/tail"
wait_js 'P2-3 new output respects reading position' "document.querySelector('[data-as-item=answer] pre')?.textContent.includes('长日志追加验证。') && Math.abs(document.querySelector('.as-shadow').scrollTop - Number(sessionStorage.getItem('as-scrolled-up'))) < 2"
ab click '[data-as-follow]'
wait_js 'P2-3 return button reaches tail' "document.querySelector('[data-as-log]')?.dataset.followTail === 'true' && (() => { const main = document.querySelector('.as-shadow'); return main.scrollHeight - main.clientHeight - main.scrollTop < 50; })()"
touch "$H/tail2"
wait_js 'P2-3 continued output automatically follows' "document.querySelector('[data-as-item=answer] pre')?.textContent.includes('再次追加并自动跟随。') && (() => { const main = document.querySelector('.as-shadow'); return main.scrollHeight - main.clientHeight - main.scrollTop < 50; })()"
ab eval 'sessionStorage.setItem("as-paused-text", document.querySelector("[data-as-item=answer] pre").textContent); true'
ab eval 'sessionStorage.setItem("as-before", document.querySelector("[data-as-log]").dataset.cursor); window.EventSource = class extends EventSource { constructor(url, options) { super(url, options); sessionStorage.setItem("as-resume-url", String(url)); } }; true'
ab eval "document.querySelector('[data-as-pause]').scrollIntoView({block:'center'}); true"
wait_js 'viewer controls stop tail before interaction' "document.querySelector('[data-as-log]')?.dataset.followTail === 'false'"
ab click '[data-as-pause]'
wait_js 'SSE disconnected by viewer' "document.querySelector('[data-as-log]')?.textContent.includes('已暂停查看') === true"
touch "$H/finish"
wait_file "$H/expected.json"
cp "$H/expected.json" "$OUT/as-expected.json"
wait_js 'offline events have not leaked into paused view' "document.querySelector('[data-as-item=answer] pre')?.textContent === sessionStorage.getItem('as-paused-text') && !document.querySelector('[data-as-item=file]')"
ab click '[data-as-pause]'
wait_js 'sinceSeq recovers completion and new items' "document.querySelector('[data-as-item=answer] pre')?.textContent.endsWith('离线片段完整补齐。') && Boolean(document.querySelector('[data-as-item=file]'))"
EXPECTED=$(cat "$H/expected.json")
ab eval --stdin <<JS > "$OUT/as-browser-proof.json"
(() => {
  const expected = $EXPECTED;
  const rows = [...document.querySelectorAll('[data-as-item]')];
  const actual = rows.map(row => ({id: row.dataset.asItem, status: row.dataset.itemStatus, text: row.querySelector('pre').textContent}));
  if (JSON.stringify(actual) !== JSON.stringify(expected.items)) throw new Error('daemon/browser item mismatch: ' + JSON.stringify(actual));
  const cursor = Number(document.querySelector('[data-as-log]').dataset.cursor);
  if (cursor !== expected.cursor || cursor <= Number(sessionStorage.getItem('as-before'))) throw new Error('cursor did not advance');
  const resumeUrl = new URL(sessionStorage.getItem('as-resume-url'), location.href);
  if (resumeUrl.searchParams.get('sinceSeq') !== sessionStorage.getItem('as-before')) throw new Error('resume did not send retained cursor');
  if (new Set(actual.map(item => item.id)).size !== actual.length) throw new Error('duplicate items');
  if (document.documentElement.scrollWidth > innerWidth) throw new Error('horizontal overflow');
  const main = document.querySelector('.as-shadow');
  if (main.scrollWidth > main.clientWidth) throw new Error('main horizontal overflow');
  const targets = [...document.querySelectorAll('.as-shadow button, .as-shadow a')].filter(el => el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); if(r.width < 44 || r.height < 44) throw new Error('small touch target'); return {label: el.textContent.trim(), width:r.width, height:r.height}; });
  main.scrollTop = main.scrollHeight;
  const last = document.querySelector('[data-as-item=file]').getBoundingClientRect();
  if (main.scrollTop <= 0 || last.bottom > innerHeight || last.top >= innerHeight) throw new Error('last log is unreachable by vertical scrolling');
  return {actual, cursor, before: sessionStorage.getItem('as-before'), resumeUrl: resumeUrl.pathname + resumeUrl.search, width:innerWidth, scrollWidth:document.documentElement.scrollWidth, scrollTop:main.scrollTop, targets};
})()
JS
ab screenshot "$OUT/mobile-as-resumed.png" --full
bun scripts/mobile-verify/as-shadow-http-verify.ts "$BASE" "$THREAD_ID" "$H/expected.json" > "$OUT/as-http-proof.json"
ab set viewport 1280 800
wait_js 'desktop no horizontal overflow' 'document.documentElement.scrollWidth <= innerWidth'
ab screenshot "$OUT/desktop-as-shadow.png" --full
echo 'PASS: daemon/browser exact item equality; live delta; offline sinceSeq completion; no missing/duplicate items; 44px targets; no overflow'
