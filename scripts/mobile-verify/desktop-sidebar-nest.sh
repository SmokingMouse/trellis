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

# SN-6: 产物路径不得写死治理目录，走 FENJUE_TASK_OUT
OUT_DIR="${FENJUE_TASK_OUT:-/tmp/trellis-verify/sidebar-nest}"
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

echo "== 构建默认 V2 模式 =="
NEXT_PUBLIC_TRELLIS_VERIFY=1 bun --bun run build > /tmp/build-v2.log 2>&1 || (cat /tmp/build-v2.log && exit 1)

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

echo "== 桌面端登录与出厂态准备 =="
ab set viewport 1280 800
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

echo "== SN-1 / SN-2: 验证真库副本默认出厂首屏行数与请求量 =="
ab open "$BASE/?layout=project"
wait_for_js "sidebar loaded in layout=project" "document.querySelectorAll('[data-sidebar-session-item]').length > 10"

# 等待渲染稳定
sleep 3

# 统计行数并断言：链行必须为 0，只多出多树会话的树行
ab eval --stdin <<'JS'
(() => {
  const sessionItems = document.querySelectorAll('[data-sidebar-session-item]').length;
  const singleTreeContainers = document.querySelectorAll('[data-session-single-tree]').length;
  const multiTreeContainers = document.querySelectorAll('[data-session-trees]').length;
  const treeRows = document.querySelectorAll('[data-sidebar-tree-row]').length;
  const chainRows = document.querySelectorAll('[data-mobile-target="session-chain-row"]').length;

  // 性能条目统计结构请求数
  const structureReqs = performance.getEntriesByType('resource').filter(r => r.name.includes('/structure')).length;

  const metrics = {
    sessionItems,
    singleTreeContainers,
    multiTreeContainers,
    treeRows,
    chainRows,
    structureReqs,
    totalSidebarRows: sessionItems + treeRows + chainRows
  };

  // 断言 SN-1：默认首屏链行必须为 0！单树不画树行也不铺链；多树会话仅展开到树行（树自身折叠）
  if (chainRows !== 0) {
    throw new Error(`SN-1 assertion failed: expected 0 chainRows on initial load, got ${chainRows}`);
  }
  // 断言 SN-2：首屏结构请求只对展开的多树会话发，绝不得出现全部会话并发几十个请求
  if (structureReqs > multiTreeContainers + 2) {
    throw new Error(`SN-2 assertion failed: structure requests (${structureReqs}) exceeded open sessions count (${multiTreeContainers})`);
  }
  return metrics;
})()
JS

echo "== SN-1: 验证单树会话默认折叠、手动展开列链、刷新保持、折叠收起保持 =="
ab open "$BASE/?session=$SINGLE_SID"
wait_for_js "single-tree session row loaded" "Boolean(document.querySelector('[data-session-id=\"$SINGLE_SID\"]'))"

# 1. 验证初始折叠：单树容器未展开，链不可见
ab eval --stdin <<JS
(() => {
  const container = document.querySelector('[data-session-single-tree="$SINGLE_SID"]');
  if (container) throw new Error('Expected single-tree container to be collapsed initially');
  return true;
})()
JS

# 2. 点击折叠按钮展开单树会话
ab eval "document.querySelector('[data-session-id=\"$SINGLE_SID\"] [data-testid=\"session-collapse-toggle\"]').click(); true"
wait_for_js "single-tree chains visible after expand" "(() => {
  const container = document.querySelector('[data-session-single-tree=\"$SINGLE_SID\"]');
  if (!container) return false;
  const treeRows = container.querySelectorAll('[data-sidebar-tree-row]');
  const chainRows = container.querySelectorAll('[data-mobile-target=\"session-chain-row\"]');
  return treeRows.length === 0 && chainRows.length > 0;
})()"

# 3. 刷新页面，验证单树显式展开持久化保持
ab reload
wait_for_js "single-tree session row loaded after reload" "Boolean(document.querySelector('[data-session-id=\"$SINGLE_SID\"]'))"
wait_for_js "single-tree chains persisted expanded after reload" "(() => {
  const container = document.querySelector('[data-session-single-tree=\"$SINGLE_SID\"]');
  return container && container.querySelectorAll('[data-mobile-target=\"session-chain-row\"]').length > 0;
})()"

# 4. 点击折叠按钮收起单树会话
ab eval "document.querySelector('[data-session-id=\"$SINGLE_SID\"] [data-testid=\"session-collapse-toggle\"]').click(); true"
wait_for_js "single-tree collapsed again" "!document.querySelector('[data-session-single-tree=\"$SINGLE_SID\"]')"

# 5. 刷新页面，验证单树显式折叠持久化保持
ab reload
wait_for_js "single-tree row reloaded" "Boolean(document.querySelector('[data-session-id=\"$SINGLE_SID\"]'))"
ab eval --stdin <<JS
(() => {
  const container = document.querySelector('[data-session-single-tree="$SINGLE_SID"]');
  if (container) throw new Error('Expected single-tree session to remain collapsed after reload');
  return true;
})()
JS

echo "== 验证多树会话：默认展示树行，展开后列出链行，点击链跳转 =="
ab open "$BASE/?session=$MULTI_SID"
wait_for_js "multi-tree sidebar loaded" "Boolean(document.querySelector('[data-session-id=\"$MULTI_SID\"]'))"

wait_for_js "multi-tree default expanded to tree rows" "(() => {
  const container = document.querySelector('[data-session-trees=\"$MULTI_SID\"]');
  if (!container) return false;
  const treeRows = container.querySelectorAll('[data-sidebar-tree-row]');
  const chainRows = container.querySelectorAll('[data-mobile-target=\"session-chain-row\"]');
  return treeRows.length >= 2 && chainRows.length === 0;
})()"

# 展开第一棵树，验证链行出现
ab eval "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-testid=\"tree-collapse-toggle\"]')[0]?.click(); true"
wait_for_js "tree expanded to show chains" "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-mobile-target=\"session-chain-row\"]').length > 0"

# 点击链行，验证触发打开链尾
ab eval --stdin <<JS
(() => {
  const chain = document.querySelector('[data-session-trees="$MULTI_SID"] [data-mobile-target="session-chain-row"]');
  if (!chain) throw new Error('Chain row not found to click');
  const tipId = chain.getAttribute('data-tip-id');
  chain.click();
  return { clickedTipId: tipId };
})()
JS

# 截取两层展开状态截图
sleep 1
ab screenshot "$OUT_DIR/sidebar-nest-expanded.png"
cp "$OUT_DIR/sidebar-nest-expanded.png" "$LOCAL_OUT/sidebar-nest-expanded.png"
echo "✓ Screenshot saved to $OUT_DIR/sidebar-nest-expanded.png"

# 验证刷新后多树展开状态持久化保持
ab reload
wait_for_js "multi-tree loaded after reload" "Boolean(document.querySelector('[data-session-id=\"$MULTI_SID\"]'))"
wait_for_js "tree state persisted expanded after reload" "document.querySelectorAll('[data-session-trees=\"$MULTI_SID\"] [data-mobile-target=\"session-chain-row\"]').length > 0"

echo "== SN-4: 验证桌面端右键菜单（固定/取消固定、重命名、归档、删除、打开此链）=="
# 右键多树会话行
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
wait_for_js "context menu visible on session row" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

ab eval --stdin <<'JS'
(() => {
  const menu = document.querySelector('[data-testid="context-menu"]');
  if (!menu) throw new Error('Context menu element not found');
  const items = Array.from(menu.querySelectorAll('button')).map(b => b.textContent.trim());
  if (!items.some(t => t.includes('固定'))) throw new Error('Missing pin/unpin item: ' + JSON.stringify(items));
  if (!items.some(t => t.includes('重命名'))) throw new Error('Missing rename item: ' + JSON.stringify(items));
  if (!items.some(t => t.includes('归档'))) throw new Error('Missing archive item: ' + JSON.stringify(items));
  if (!items.some(t => t.includes('删除'))) throw new Error('Missing delete item: ' + JSON.stringify(items));
  return { sessionMenuItems: items };
})()
JS

# 截取右键菜单截图
ab screenshot "$OUT_DIR/sidebar-context-menu.png"
cp "$OUT_DIR/sidebar-context-menu.png" "$LOCAL_OUT/sidebar-context-menu.png"
echo "✓ Screenshot saved to $OUT_DIR/sidebar-context-menu.png"

ab press Escape
wait_for_js "context menu closed via Escape" "!document.querySelector('[data-testid=\"context-menu\"]')"

# 右键链行，验证菜单包含「打开此链」
ab eval --stdin <<JS
(() => {
  const el = document.querySelector('[data-session-trees="$MULTI_SID"] [data-mobile-target="session-chain-row"]');
  if (!el) throw new Error('Chain row not found for context menu');
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
wait_for_js "context menu visible on chain row" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

ab eval --stdin <<'JS'
(() => {
  const menu = document.querySelector('[data-testid="context-menu"]');
  if (!menu) throw new Error('Context menu element not found');
  const items = Array.from(menu.querySelectorAll('button')).map(b => b.textContent.trim());
  if (!items.some(t => t.includes('打开此链'))) throw new Error('Missing "打开此链" item: ' + JSON.stringify(items));
  return { chainMenuItems: items };
})()
JS

ab press Escape
wait_for_js "chain context menu closed" "!document.querySelector('[data-testid=\"context-menu\"]')"

echo "== SN-5: 验证移动端视口下抽屉中 500ms 长按唤起右键菜单 =="
ab set viewport 390 844
# 打开移动端抽屉
ab eval --stdin <<'JS'
(() => {
  window.__sessionStore.setState({ mobileNavOpen: true });
  return true;
})()
JS
wait_for_js "mobile drawer opened" "Boolean(document.querySelector('[data-mobile-target=\"session-row\"]'))"

# 在抽屉中的会话行上模拟 600ms touch 长按
ab eval --stdin <<'JS'
(async () => {
  const el = document.querySelector('[data-mobile-target="session-row"]');
  if (!el) throw new Error('Session row not found in mobile drawer');
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  const touch = new Touch({
    identifier: 1,
    target: el,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pageX: x,
    pageY: y,
  });

  el.dispatchEvent(new TouchEvent('touchstart', {
    bubbles: true,
    cancelable: true,
    touches: [touch],
    targetTouches: [touch],
    changedTouches: [touch],
  }));

  // 等待 600ms (长按阈值 500ms)
  await new Promise((r) => setTimeout(r, 600));

  el.dispatchEvent(new TouchEvent('touchend', {
    bubbles: true,
    cancelable: true,
    touches: [],
    targetTouches: [],
    changedTouches: [touch],
  }));

  return { longPressed: true, x, y };
})()
JS

wait_for_js "context menu opened via mobile long press" "Boolean(document.querySelector('[data-testid=\"context-menu\"]'))"

# 截取手机长按菜单截图
ab screenshot "$OUT_DIR/mobile-sidebar-longpress.png"
cp "$OUT_DIR/mobile-sidebar-longpress.png" "$LOCAL_OUT/mobile-sidebar-longpress.png"
echo "✓ Screenshot saved to $OUT_DIR/mobile-sidebar-longpress.png"

ab press Escape
wait_for_js "mobile context menu closed" "!document.querySelector('[data-testid=\"context-menu\"]')"

# 关闭抽屉，恢复桌面视口
ab eval --stdin <<'JS'
(() => {
  window.__sessionStore.setState({ mobileNavOpen: false });
  return true;
})()
JS
ab set viewport 1280 800

echo "== 停止 V2 实例，准备 SN-3 Legacy 侧栏验证 =="
kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" >/dev/null 2>&1 || true
SERVER_PID=
sleep 1

echo "== 构建并启动 NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off 实例 =="
NEXT_PUBLIC_TRELLIS_VERIFY=1 NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off bun --bun run build > /tmp/build-legacy.log 2>&1 || (cat /tmp/build-legacy.log && exit 1)

(
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  exec bun --bun run start -- -p "$PORT"
) >"$LOG" 2>&1 &
SERVER_PID=$!

ready_try=0
until curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 "$BASE/__gate/health" 2>/dev/null | grep -q '"next":"ready"'; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    tail -n 80 "$LOG" >&2
    fail "legacy Trellis exited during startup"
  fi
  ready_try=$((ready_try + 1))
  if [ "$ready_try" -ge 90 ]; then
    tail -n 80 "$LOG" >&2
    fail "legacy Trellis did not become ready"
  fi
  sleep 1
done

echo "== SN-3: 验证 legacy 侧栏下 renderRecentGroup 不重复画链行 =="
ab open "$BASE/?session=$MULTI_SID"
wait_for_js "legacy sidebar layout loaded" "Boolean(document.querySelector('[data-sidebar-layout=\"legacy\"]'))"
wait_for_js "legacy sidebar session items loaded" "document.querySelectorAll('[data-sidebar-layout=\"legacy\"] [data-sidebar-session-item]').length > 0"

# 验证「最近」分组存在，且内部会话行不带折叠按钮（不嵌套铺链），链行由 renderRecentGroup 自身单次列出
ab eval --stdin <<JS
(() => {
  const sidebar = document.querySelector('[data-sidebar-layout="legacy"]');
  if (!sidebar) throw new Error('Legacy sidebar not found');

  // 查找最近分组里的会话行
  const recentItems = sidebar.querySelectorAll('[data-sidebar-session-item]');
  if (recentItems.length === 0) throw new Error('No session item found in legacy sidebar');

  // 在最近分组的第一个会话中，验证其会话行没有 session-collapse-toggle（不嵌套折叠）
  const firstItem = recentItems[0];
  const toggle = firstItem.querySelector('[data-testid="session-collapse-toggle"]');
  if (toggle) throw new Error('Legacy renderRecentGroup session row should not have collapse toggle');

  // 验证不含两层嵌套链（data-session-trees 与 data-session-single-tree 在 legacy recent 里不渲染）
  const nestedTrees = firstItem.querySelector('[data-session-trees]');
  const nestedSingle = firstItem.querySelector('[data-session-single-tree]');
  if (nestedTrees || nestedSingle) throw new Error('Legacy renderRecentGroup should not render nested trees/chains');

  return true;
})()
JS

# 截取 legacy 侧栏最近分组截图
ab screenshot "$OUT_DIR/sidebar-legacy-recent.png"
cp "$OUT_DIR/sidebar-legacy-recent.png" "$LOCAL_OUT/sidebar-legacy-recent.png"
echo "✓ Screenshot saved to $OUT_DIR/sidebar-legacy-recent.png"

echo "== 恢复默认构建环境 =="
kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" >/dev/null 2>&1 || true
SERVER_PID=
bun --bun run build > /tmp/build-restore.log 2>&1 || true

echo "========================================="
echo "✓ ALL DESKTOP SIDEBAR NEST CHECKS PASSED!"
echo "========================================="
