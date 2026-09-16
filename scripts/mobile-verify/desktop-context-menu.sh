#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=${TRELLIS_VERIFY_PORT:-3482}
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-desktop-context-menu
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
SESSION=desktop-context-menu
AUTH_PASS=desktop-context-menu-pass
AUTH_TOKEN=desktop-context-menu-token
SERVER_PID=
OUT_DIR="${FENJUE_TASK_OUT:-/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-panel-menu-ecba/out}"

fail() {
  echo "desktop-context-menu: $*" >&2
  exit 1
}

ab() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"
}

close_browser() {
  close_try=0
  while [ "$close_try" -lt 5 ]; do
    if ab close >/dev/null 2>&1; then
      return 0
    fi
    close_try=$((close_try + 1))
    sleep 1
  done
  echo "WARN: could not close agent-browser session $SESSION" >&2
  return 0
}

cleanup() {
  cleanup_status=$?
  trap - 0 1 2 15
  close_browser
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  leftover_pids=$(ps -ax -o pid= -o command= | awk -v p="$PORT" '$0 ~ /bun.*run.*start.*-p/ && $0 ~ p { print $1 }')
  if [ -n "$leftover_pids" ]; then
    kill $leftover_pids >/dev/null 2>&1 || true
  fi
  cleanup_wait=0
  while curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; do
    cleanup_wait=$((cleanup_wait + 1))
    if [ "$cleanup_wait" -ge 10 ]; then
      echo "FAIL: port $PORT still responds after cleanup" >&2
      cleanup_status=1
      break
    fi
    sleep 1
  done
  rm -rf "$LOCK_DIR"
  exit "$cleanup_status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

LOCK_DIR=/tmp/trellis-desktop-context-menu.lock
lock_wait=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_wait=$((lock_wait + 1))
  if [ "$lock_wait" -ge 180 ]; then
    echo "FAIL: lock wait timeout (held by $(cat "$LOCK_DIR/owner" 2>/dev/null))"
    exit 1
  fi
  sleep 5
done
echo "$$ $(date +%H:%M:%S) $(basename "$0")" > "$LOCK_DIR/owner"

print_page_diagnostics() {
  ab eval --stdin <<'JS' || true
(() => {
  const body = (document.body?.innerText || document.body?.textContent || '').slice(0, 500);
  return `location=${location.href}\ntitle=${document.title}\nbody=${body}`;
})()
JS
}

wait_for_js() {
  wait_label=$1
  wait_expression=$2
  wait_try=0
  while :; do
    if ab eval "$wait_expression" 2>/dev/null | grep -q '^true$'; then
      echo "✓ $wait_label"
      return 0
    fi
    wait_try=$((wait_try + 1))
    if [ "$wait_try" -ge 90 ]; then
      echo "FAIL: timed out waiting for $wait_label" >&2
      print_page_diagnostics
      return 1
    fi
    sleep 1
  done
}

for required_tool in bun agent-browser sqlite3 curl grep find ps awk lsof; do
  command -v "$required_tool" >/dev/null 2>&1 || fail "missing required tool: $required_tool"
done
[ -f "$SOURCE_DB" ] || fail "source database missing: $SOURCE_DB"

close_browser
if curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; then
  fail "port $PORT is already serving HTTP"
fi

NEED_BUILD=0
BUILD_STAMP=.next/BUILD_ID
if [ ! -f "$BUILD_STAMP" ]; then
  NEED_BUILD=1
else
  for source_dir in app components hooks lib stores public; do
    if [ -d "$source_dir" ] && find "$source_dir" -type f -newer "$BUILD_STAMP" -print | grep -q .; then
      NEED_BUILD=1
      break
    fi
  done
  if [ "$NEED_BUILD" -eq 0 ]; then
    for source_file in package.json bun.lock next.config.ts postcss.config.mjs tsconfig.json server.ts instrumentation.ts proxy.ts; do
      if [ -f "$source_file" ] && find "$source_file" -newer "$BUILD_STAMP" -print | grep -q .; then
        NEED_BUILD=1
        break
      fi
    done
  fi
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  echo "== build: required =="
  bun --bun run build
else
  echo "== build: current .next reused =="
fi

mkdir -p "$H/.trellis"
rm -f "$DB" "$DB-shm" "$DB-wal" "$LOG"
sqlite3 "$SOURCE_DB" ".backup '$DB'"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

# Pick a session with at least 2 nodes
SID=$(sqlite3 "$DB" "SELECT session_id FROM nodes WHERE session_id IN (SELECT id FROM sessions WHERE archived=0 AND kind='user') GROUP BY session_id HAVING count(*) >= 2 ORDER BY count(*) ASC LIMIT 1;")
if [ -z "$SID" ]; then
  SID=$(sqlite3 "$DB" "SELECT session_id FROM nodes GROUP BY session_id HAVING count(*) >= 2 ORDER BY count(*) ASC LIMIT 1;")
fi
[ -n "$SID" ] || fail "database copy has no session with at least 2 nodes"

N1=$(sqlite3 "$DB" "SELECT id FROM nodes WHERE session_id='$SID' ORDER BY created_at ASC LIMIT 1;")
N2=$(sqlite3 "$DB" "SELECT id FROM nodes WHERE session_id='$SID' AND id != '$N1' ORDER BY created_at DESC LIMIT 1;")
[ -n "$N1" ] || fail "failed to find node 1"
[ -n "$N2" ] || fail "failed to find node 2"

(
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  exec bun --bun run start -- -p "$PORT"
) >"$LOG" 2>&1 &
SERVER_PID=$!

ready_try=0
until curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 "$BASE/__gate/health" 2>/dev/null | grep -q '"next":"ready"'; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    tail -n 80 "$LOG" >&2
    fail "isolated Trellis exited during startup"
  fi
  ready_try=$((ready_try + 1))
  if [ "$ready_try" -ge 90 ]; then
    tail -n 80 "$LOG" >&2
    fail "isolated Trellis did not become ready"
  fi
  sleep 1
done

echo "== desktop: authenticate and set viewport =="
ab set viewport 1280 800
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

echo "== desktop: navigate to test session with node 1 =="
URL="$BASE/?session=$SID&node=$N1"
ab open "$URL"
wait_for_js "structure panel loaded with nodes" "Boolean(document.querySelector('[data-node-id]'))"

echo "== desktop: right click node in TreePanel =="
# Trigger contextmenu on the first node row
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-node-id]');
  if (!el) throw new Error('no node row found in TreePanel');
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  return { triggered: true, nodeId: el.getAttribute('data-node-id'), x, y };
})()
JS

wait_for_js "context-menu opened" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

echo "== desktop: verify context menu contains delete item =="
ab eval --stdin <<'JS'
(() => {
  const menu = document.querySelector('[data-testid="context-menu"]');
  if (!menu) throw new Error('context-menu not found');
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(el => el.textContent?.trim());
  const hasDelete = items.some(t => t && t.includes('删除'));
  if (!hasDelete) throw new Error('context-menu does not contain delete item: ' + JSON.stringify(items));
  return true;
})()
JS

mkdir -p "$OUT_DIR"
ab screenshot "$OUT_DIR/desktop-context-menu.png"
echo "✓ saved context-menu screenshot to $OUT_DIR/desktop-context-menu.png"

echo "== desktop: press Escape to close context menu =="
ab press Escape
wait_for_js "context-menu closed via Escape" "!document.querySelector('[data-testid=\"context-menu\"]')"

echo "== desktop: right click non-active node and jump =="
TARGET_NODE=$(ab eval --stdin <<'JS' | tr -d '"'
(() => {
  const activeId = new URL(location.href).searchParams.get('node');
  const rows = Array.from(document.querySelectorAll('[data-node-id]'));
  const candidate = rows.find(r => r.getAttribute('data-node-id') !== activeId) || rows[0];
  return candidate?.getAttribute('data-node-id') || '';
})()
JS
)
[ -n "$TARGET_NODE" ] || fail "could not find target node for jump"

ab eval --stdin <<JS
(() => {
  const el = document.querySelector('[data-node-id="$TARGET_NODE"]');
  if (!el) throw new Error('target node element not found');
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  return { triggered: true, nodeId: '$TARGET_NODE' };
})()
JS

wait_for_js "context-menu opened for target node" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

ab eval --stdin <<'JS'
(() => {
  const menu = document.querySelector('[data-testid="context-menu"]');
  if (!menu) throw new Error('context-menu not found');
  const buttons = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const jumpBtn = buttons.find(b => b.textContent && b.textContent.includes('跳转'));
  if (!jumpBtn) throw new Error('no jump menuitem found: ' + JSON.stringify(buttons.map(b => b.textContent)));
  jumpBtn.click();
  return { clicked: true, text: jumpBtn.textContent?.trim() };
})()
JS

wait_for_js "context-menu closed after jump" "!document.querySelector('[data-testid=\"context-menu\"]')"

wait_for_js "active node changed to target" "(() => {
  const url = new URL(location.href);
  return url.searchParams.get('node') === '$TARGET_NODE';
})()"

echo "== ALL CHECKS PASSED: desktop-context-menu =="
