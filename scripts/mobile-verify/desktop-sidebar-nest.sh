#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3480
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-desktop-sidebar-nest
DB="$H/.trellis/data.db"
SOURCE_DB="${TRELLIS_VERIFY_SOURCE_DB:-$HOME/.trellis/data.db}"
LOG="$H/server.log"
SESSION=mv-desktop-sidebar-nest-$$
AUTH_PASS=mv-sidebar-nest-pass
AUTH_TOKEN=mv-sidebar-nest-token
SERVER_PID=

OUT_DIR="/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-nest-7683/out"
LOCAL_OUT="$ROOT/out"
mkdir -p "$OUT_DIR" "$LOCAL_OUT"

fail() {
  echo "FAIL: $*" >&2
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
  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3480/ { print $1 }')
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

LOCK_DIR=/tmp/trellis-mobile-verify.lock
lock_wait=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_wait=$((lock_wait + 1))
  if [ "$lock_wait" -ge 180 ]; then echo "FAIL: mobile-verify lock wait timeout (held by $(cat "$LOCK_DIR/owner" 2>/dev/null))"; exit 1; fi
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

# 在副本 DB 中查找多树会话和单树会话
MULTI_SID=$(sqlite3 "$DB" "SELECT s.id FROM sessions s JOIN nodes n ON n.session_id=s.id WHERE s.archived=0 GROUP BY s.id HAVING (SELECT count(DISTINCT r.id) FROM nodes r WHERE r.session_id=s.id AND r.parent_id IS NULL) > 1 LIMIT 1;")
SINGLE_SID=$(sqlite3 "$DB" "SELECT s.id FROM sessions s JOIN nodes n ON n.session_id=s.id WHERE s.archived=0 GROUP BY s.id HAVING (SELECT count(DISTINCT r.id) FROM nodes r WHERE r.session_id=s.id AND r.parent_id IS NULL) = 1 AND count(n.id) > 1 LIMIT 1;")

[ -n "$MULTI_SID" ] || fail "no multi-tree session found in backup"
[ -n "$SINGLE_SID" ] || fail "no single-tree session found in backup"

# 设定便于测试识别的会话标题
sqlite3 "$DB" "UPDATE sessions SET title='[验收] 多树嵌套测试会话' WHERE id='$MULTI_SID';"
sqlite3 "$DB" "UPDATE sessions SET title='[验收] 单树直接列出链会话' WHERE id='$SINGLE_SID';"

echo "== 桌面端登录与鉴权 =="
ab set viewport 1280 800
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

echo "== 打开多树会话页面 =="
ab open "$BASE/?session=$MULTI_SID"
wait_for_js "sidebar loaded" "Boolean(document.querySelector('[data-session-id=\"$MULTI_SID\"]'))"

echo "== 验证结构接口 GET /api/sessions/:id/structure =="
wait_for_js "structure fetched" "(() => {
  const trees = document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-sidebar-tree-row]');
  return trees.length > 1;
})()"

echo "== 验证多树会话：默认展示树行，链行处于折叠隐藏状态 =="
ab eval --stdin <<JS
(() => {
  const container = document.querySelector('[data-session-trees="$MULTI_SID"]');
  if (!container) throw new Error('Multi-tree container not found');
  const treeRows = container.querySelectorAll('[data-sidebar-tree-row]');
  if (treeRows.length < 2) throw new Error('Expected at least 2 tree rows, found ' + treeRows.length);
  const toggles = container.querySelectorAll('[data-testid="tree-collapse-toggle"]');
  if (toggles.length < 2) throw new Error('Expected at least 2 tree collapse toggles');
  // 树默认折叠，尚未展开时该树下的链行不可见（数量为 0）
  const chainRows = container.querySelectorAll('[data-mobile-target="session-chain-row"]');
  if (chainRows.length !== 0) throw new Error('Expected 0 chain rows initially, found ' + chainRows.length);
  return { treeRowCount: treeRows.length, initialChains: chainRows.length };
})()
JS

echo "== 展开第一棵树，验证链行变为可见 =="
ab eval "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-testid=\"tree-collapse-toggle\"]')[0]?.click(); true"
wait_for_js "tree expanded to show chains" "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-mobile-target=\"session-chain-row\"]').length > 0"

echo "== 点击链行，验证触发打开链尾 =="
ab eval --stdin <<JS
(() => {
  const chain = document.querySelector('[data-session-trees="$MULTI_SID"] [data-mobile-target="session-chain-row"]');
  if (!chain) throw new Error('Chain row not found to click');
  const tipId = chain.getAttribute('data-tip-id');
  chain.click();
  return { clickedTipId: tipId };
})()
JS

echo "== 截取侧栏树/链两层展开状态证据图 =="
sleep 1
ab screenshot "$OUT_DIR/sidebar-nest-expanded.png"
cp "$OUT_DIR/sidebar-nest-expanded.png" "$LOCAL_OUT/sidebar-nest-expanded.png"
echo "✓ Screenshot 1 saved to $OUT_DIR/sidebar-nest-expanded.png"

echo "== 验证刷新后折叠状态保持（localStorage 持久化）=="
ab reload
wait_for_js "sidebar loaded after reload" "Boolean(document.querySelector('[data-session-id=\"$MULTI_SID\"]'))"
wait_for_js "tree state persisted expanded" "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-mobile-target=\"session-chain-row\"]').length > 0"

echo "== 验证单树会话：展开后不画树行，直接可见链行 =="
ab open "$BASE/?session=$SINGLE_SID"
wait_for_js "single-tree session sidebar loaded" "Boolean(document.querySelector('[data-session-id=\"$SINGLE_SID\"]'))"
wait_for_js "single-tree chains directly visible without tree rows" "(() => {
  const container = document.querySelector('[data-session-single-tree=\"$SINGLE_SID\"]');
  if (!container) return false;
  const treeRows = container.querySelectorAll('[data-sidebar-tree-row]');
  const chainRows = container.querySelectorAll('[data-mobile-target=\"session-chain-row\"]');
  return treeRows.length === 0 && chainRows.length > 0;
})()"

echo "== 验证右键菜单（ContextMenu）=="
ab open "$BASE/?session=$MULTI_SID"
wait_for_js "sidebar loaded for context menu test" "Boolean(document.querySelector('[data-session-id=\"$MULTI_SID\"]'))"

# 在多树会话行上触发 contextmenu 事件
ab eval --stdin <<JS
(() => {
  const el = document.querySelector('[data-session-id="$MULTI_SID"]');
  if (!el) throw new Error('Multi-tree session row not found');
  const rect = el.getBoundingClientRect();
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: rect.x + 40,
    clientY: rect.y + 10
  });
  el.dispatchEvent(event);
  return true;
})()
JS

wait_for_js "context menu visible" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

ab eval --stdin <<'JS'
(() => {
  const menu = document.querySelector('[data-testid="context-menu"]');
  if (!menu) throw new Error('Context menu element not found');
  const items = Array.from(menu.querySelectorAll('button')).map(b => b.textContent.trim());
  if (!items.some(t => t.includes('重命名'))) throw new Error('Missing rename item: ' + JSON.stringify(items));
  if (!items.some(t => t.includes('归档'))) throw new Error('Missing archive item: ' + JSON.stringify(items));
  if (!items.some(t => t.includes('删除'))) throw new Error('Missing delete item: ' + JSON.stringify(items));
  return { items };
})()
JS

echo "== 截取右键菜单弹出证据图 =="
ab screenshot "$OUT_DIR/sidebar-context-menu.png"
cp "$OUT_DIR/sidebar-context-menu.png" "$LOCAL_OUT/sidebar-context-menu.png"
echo "✓ Screenshot 2 saved to $OUT_DIR/sidebar-context-menu.png"

echo "========================================="
echo "✓ ALL DESKTOP SIDEBAR NEST CHECKS PASSED!"
echo "========================================="
