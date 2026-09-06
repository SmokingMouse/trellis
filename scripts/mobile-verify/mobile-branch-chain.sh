#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3478
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-branch-chain
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
OUT="$H/out"
SESSION=mv-mobile-branch-chain
AUTH_PASS=mv-mobile-branch-chain-pass
AUTH_TOKEN=mv-mobile-branch-chain-token
SERVER_PID=

SID=mv-chain-session
ROOT_ID=mv-chain-root
PLAIN_ID=mv-chain-plain
ANCHORED_ID=mv-chain-anchored
ROOT2_ID=mv-chain-root-two
OTHER_SID=mv-chain-other-session
OTHER_ID=mv-chain-other-root

fail() {
  echo "mobile-branch-chain: $*" >&2
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
  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3478/ { print $1 }')
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
  const body = (document.body?.innerText || document.body?.textContent || '').slice(0, 600);
  const sid = new URL(location.href).searchParams.get('session');
  const saved = sid ? localStorage.getItem('trellis-view:' + sid) : null;
  const state = {
    viewport: [innerWidth, innerHeight],
    saved,
    composer: document.querySelector('[data-mobile-composer]')?.dataset.composerState,
    header: Boolean(document.querySelector('[data-mobile-header]')),
    threadHeader: Boolean(document.querySelector('[data-thread-header]')),
    canvas: Boolean(document.querySelector('[data-canvas-surface]')),
    nodeIds: [...document.querySelectorAll('[data-thread-node-id]')].map((element) => element.getAttribute('data-thread-node-id')),
  };
  return `location=${location.href}\ntitle=${document.title}\nstate=${JSON.stringify(state)}\nbody=${body}`;
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

wait_for_db_node() {
  question=$1
  db_try=0
  while :; do
    node_id=$(sqlite3 "$DB" "SELECT id FROM nodes WHERE session_id='$SID' AND question='$question' AND status='done' ORDER BY created_at DESC LIMIT 1;")
    if [ -n "$node_id" ]; then
      echo "$node_id"
      return 0
    fi
    db_try=$((db_try + 1))
    if [ "$db_try" -ge 90 ]; then
      fail "timed out waiting for completed node: $question"
    fi
    sleep 1
  done
}

assert_mobile_landing() {
  expected=$1
  label=$2
  wait_for_js "$label" "(() => {
    const saved = JSON.parse(localStorage.getItem('trellis-view:$SID') || 'null');
    const node = new URL(location.href).searchParams.get('node');
    return innerWidth === 390
      && localStorage.getItem('trellis-desktop-mode') === null
      && saved?.activeNodeId === '$expected'
      && saved?.viewMode === 'linear'
      && node === '$expected'
      && Boolean(document.querySelector('[data-mobile-header]'))
      && Boolean(document.querySelector('[data-thread-header]'))
      && Boolean(document.querySelector('[data-thread-node-id=\"$expected\"]'))
      && document.querySelector('[data-mobile-composer]')?.dataset.composerState === 'compact'
      && !document.querySelector('[data-canvas-surface]');
  })()"
}

open_mobile_overflow() {
  wait_for_js "mobile header available" "Boolean(document.querySelector('[data-mobile-header]'))"
  ab eval 'document.querySelector("[data-mobile-header] [aria-label=\"更多功能\"]")?.click(); true' >/dev/null
  wait_for_js "mobile overflow open" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
}

open_mobile_drawer() {
  wait_for_js "mobile header available" "Boolean(document.querySelector('[data-mobile-header]'))"
  ab eval 'document.querySelector("[data-mobile-header] [aria-label=\"会话列表\"]")?.click(); true' >/dev/null
  wait_for_js "mobile session drawer" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-close]'))"
}

click_recent_chain() {
  needle=$1
  ab eval "(() => {
    const rows = [...document.querySelectorAll('[data-mobile-target=\"session-chain-row\"]')];
    const row = rows.find((element) => element.textContent?.includes('$needle') && element.offsetParent !== null);
    if (!row) throw new Error('recent chain not found: $needle; rows=' + rows.map((element) => element.textContent?.trim()).join(' | '));
    row.click();
    return row.textContent?.trim();
  })()"
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

mkdir -p "$H/.trellis" "$OUT"
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
    tail -n 100 "$LOG" >&2
    fail "isolated Trellis exited during startup"
  fi
  ready_try=$((ready_try + 1))
  if [ "$ready_try" -ge 90 ]; then
    tail -n 100 "$LOG" >&2
    fail "isolated Trellis did not become ready"
  fi
  sleep 1
done

# Insert after startup so migrations have completed. Every send stays on the
# in-process mock provider; no Claude/Codex process or external model is used.
sqlite3 "$DB" <<'SQL'
INSERT INTO sessions
  (id,title,root_node_id,created_at,updated_at,context_mode,archived,require_approval,kind,title_source,model)
VALUES
  ('mv-chain-session','手机分链验收会话','mv-chain-root',1893456000000,1893456400000,'chat',0,0,'user','user','mock'),
  ('mv-chain-other-session','跨会话验收目标','mv-chain-other-root',1893455000000,1893456500000,'chat',0,0,'user','user','mock');

INSERT INTO nodes
  (id,session_id,parent_id,parent_anchor_text,question,response,status,sibling_index,created_at,read_at)
VALUES
  ('mv-chain-root','mv-chain-session',NULL,NULL,'分链共同根节点','共同根的回答用于分叉、选区与行内链导航。','done',0,1893456000000,1893456001000),
  ('mv-chain-plain','mv-chain-session','mv-chain-root',NULL,'预置普通子链','普通 child 的回答。','done',0,1893456100000,1893456101000),
  ('mv-chain-anchored','mv-chain-session','mv-chain-root','预置选中文字','预置锚点分支','带 parent anchor 的 child 回答。','done',1,1893456200000,1893456201000),
  ('mv-chain-root-two','mv-chain-session',NULL,NULL,'第二棵树长文','用于 Recent 同会话换链与滚动隐藏。','done',1,1893456300000,1893456301000),
  ('mv-chain-other-root','mv-chain-other-session',NULL,NULL,'跨会话 Recent 链','跨会话导航保持既有线性落点。','done',0,1893456500000,1893456501000);

UPDATE nodes
SET response = (
  WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 90
  )
  SELECT group_concat('第 ' || n || ' 段：这是用于手机分链、URL 跟随与滚动隐藏验收的稳定长回答。', char(10) || char(10))
  FROM seq
)
WHERE id IN ('mv-chain-root','mv-chain-root-two');
SQL

fixture_chains=$(sqlite3 "$DB" "SELECT count(*) FROM nodes n WHERE n.session_id='$SID' AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id=n.id);")
[ "$fixture_chains" = "3" ] || fail "fixture expected three chains, got $fixture_chains"

echo "== authenticate isolated iPhone session =="
ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); localStorage.setItem("trellis-provider", "mock"); true' >/dev/null
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

PLAIN_URL="$BASE/?session=$SID&node=$PLAIN_ID"

echo "== 1. fixture and mobile preconditions =="
ab open "$PLAIN_URL"
assert_mobile_landing "$PLAIN_ID" "three-chain fixture opened in mobile linear shell"

echo "== 1–5. inline branch navigation publishes the node query =="
ab eval "(() => {
  const card = document.querySelector('[data-thread-node-id=\"$ROOT_ID\"]');
  const toggle = [...card.querySelectorAll('button')].find((element) => element.textContent?.includes('个分支'));
  if (!toggle) throw new Error('inline branch toggle missing');
  toggle.click();
  return true;
})()" >/dev/null
wait_for_js "inline anchored branch listed" "(() => {
  const card=document.querySelector('[data-thread-node-id=\"$ROOT_ID\"]');
  return [...card.querySelectorAll('button')].some((element) => element.textContent?.includes('预置锚点分支'));
})()"
ab eval "(() => {
  const card=document.querySelector('[data-thread-node-id=\"$ROOT_ID\"]');
  const row=[...card.querySelectorAll('button')].find((element) => element.textContent?.includes('预置锚点分支'));
  if (!row) throw new Error('inline anchored branch row missing');
  row.click();
  return true;
})()" >/dev/null
assert_mobile_landing "$ANCHORED_ID" "inline branch updates active node and URL"
wait_for_js "inline plain branch listed" "(() => {
  const card=document.querySelector('[data-thread-node-id=\"$ROOT_ID\"]');
  return [...card.querySelectorAll('button')].some((element) => element.textContent?.includes('预置普通子链'));
})()"
ab eval "(() => {
  const card=document.querySelector('[data-thread-node-id=\"$ROOT_ID\"]');
  const row=[...card.querySelectorAll('button')].find((element) => element.textContent?.includes('预置普通子链'));
  if (!row) throw new Error('inline plain branch row missing');
  row.click();
  return true;
})()" >/dev/null
assert_mobile_landing "$PLAIN_ID" "inline navigation returns to plain chain"

echo "== 2a. card branch focuses the new plain child =="
ab eval "(() => {
  const button=document.querySelector('[data-thread-node-id=\"$ROOT_ID\"] [data-mobile-target=\"node-branch\"]');
  if (!button) throw new Error('card branch button missing');
  button.click();
  return true;
})()" >/dev/null
wait_for_js "card branch Composer expanded" "document.querySelector('[data-mobile-composer]')?.dataset.composerState === 'expanded'"
CARD_Q=手机卡片分支聚焦验收
ab fill '[data-composer-input]' "$CARD_Q"
ab click '[data-mobile-composer] button[aria-label="发送"]'
CARD_ID=$(wait_for_db_node "$CARD_Q")
assert_mobile_landing "$CARD_ID" "card branch new node active"
[ "$(sqlite3 "$DB" "SELECT coalesce(parent_anchor_text,'NULL') FROM nodes WHERE id='$CARD_ID';")" = "NULL" ] || fail "plain card branch unexpectedly has an anchor"

echo "== 2b. selected-text BranchPopover focuses its anchored child =="
ab scrollintoview "[data-thread-node-id=\"$CARD_ID\"] p"
ab eval --stdin <<JS
(() => {
  const paragraph = document.querySelector('[data-thread-node-id=\"$CARD_ID\"] p');
  const text = paragraph?.firstChild;
  if (!text || !text.textContent) throw new Error('branch source paragraph missing');
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(18, text.textContent.length));
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return range.toString();
})()
JS
wait_for_js "selection BranchPopover" "Boolean(document.querySelector('[data-branch-popover] [data-mobile-target=branch-open]'))"
ab eval 'document.querySelector("[data-mobile-target=branch-open]")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); true' >/dev/null
wait_for_js "selection followup input" "Boolean(document.querySelector('[data-branch-popover] textarea'))"
SELECT_Q=手机选区分支聚焦验收
ab fill '[data-branch-popover] textarea' "$SELECT_Q"
ab click '[data-mobile-target="branch-submit"]'
SELECT_ID=$(wait_for_db_node "$SELECT_Q")
ab eval "(() => {
  const saved=JSON.parse(localStorage.getItem('trellis-view:$SID') || 'null');
  return {
    expected: '$SELECT_ID',
    href: location.href,
    saved,
    composer: document.querySelector('[data-mobile-composer]')?.dataset.composerState,
    nodePresent: Boolean(document.querySelector('[data-thread-node-id=\"$SELECT_ID\"]')),
    canvas: Boolean(document.querySelector('[data-canvas-surface]')),
  };
})()"
assert_mobile_landing "$SELECT_ID" "selection branch new node active"
[ -n "$(sqlite3 "$DB" "SELECT parent_anchor_text FROM nodes WHERE id='$SELECT_ID';")" ] || fail "selection branch lost parent_anchor_text"

echo "== 2c. editing an anchored node always focuses the re-asked sibling =="
ab click "[data-thread-node-id=\"$SELECT_ID\"] [aria-label=\"编辑问题\"]"
wait_for_js "anchored edit input" "Boolean(document.querySelector('[data-thread-node-id=\"$SELECT_ID\"] textarea'))"
EDIT_Q=手机锚点节点重问聚焦验收
ab fill "[data-thread-node-id=\"$SELECT_ID\"] textarea" "$EDIT_Q"
ab eval "(() => {
  const card = document.querySelector('[data-thread-node-id=\"$SELECT_ID\"]');
  const button = [...card.querySelectorAll('button')].find((element) => element.textContent?.includes('重问'));
  if (!button) throw new Error('re-ask button missing');
  button.click();
  return true;
})()" >/dev/null
EDIT_ID=$(wait_for_db_node "$EDIT_Q")
assert_mobile_landing "$EDIT_ID" "anchored edit new sibling active"
[ -n "$(sqlite3 "$DB" "SELECT parent_anchor_text FROM nodes WHERE id='$EDIT_ID';")" ] || fail "anchored edit lost parent_anchor_text"

echo "== 3a. cancelling mobile new tree stays linear with TreePanel closed =="
open_mobile_overflow
ab click '[data-mobile-target="overflow-tree"]'
wait_for_js "mobile TreePanel open" "Boolean(document.querySelector('[data-mobile-tree-sheet=open] [data-mobile-target=new-tree-open]'))"
ab click '[data-mobile-target="new-tree-open"]'
wait_for_js "new-tree picker without stale TreePanel" "Boolean(document.querySelector('[data-mobile-target=new-tree-start]')) && !document.querySelector('[data-mobile-tree-sheet]')"
ab click '[data-mobile-target="new-tree-cancel"]'
wait_for_js "new-tree cancel returns to linear with TreePanel closed" "(() => {
  const saved=JSON.parse(localStorage.getItem('trellis-view:$SID') || 'null');
  return !document.querySelector('[data-mobile-target=new-tree-start]')
    && !document.querySelector('[data-mobile-tree-sheet]')
    && saved?.viewMode === 'linear'
    && Boolean(document.querySelector('[data-thread-header]'))
    && !document.querySelector('[data-canvas-surface]');
})()"
assert_mobile_landing "$EDIT_ID" "new-tree cancel preserves the active linear chain"

echo "== 3b. mobile new tree closes TreePanel before picker and after submit =="
open_mobile_overflow
ab click '[data-mobile-target="overflow-tree"]'
wait_for_js "mobile TreePanel reopened" "Boolean(document.querySelector('[data-mobile-tree-sheet=open] [data-mobile-target=new-tree-open]'))"
ab click '[data-mobile-target="new-tree-open"]'
wait_for_js "reopened new-tree picker without stale TreePanel" "Boolean(document.querySelector('[data-mobile-target=new-tree-start]')) && !document.querySelector('[data-mobile-tree-sheet]')"
TREE_Q=手机新树关闭面板验收
ab fill 'textarea[placeholder^="为这棵新树"]' "$TREE_Q"
ab click '[data-mobile-target="new-tree-start"]'
TREE_ID=$(wait_for_db_node "$TREE_Q")
assert_mobile_landing "$TREE_ID" "new tree active in mobile linear shell"
wait_for_js "TreePanel remains closed after new tree" "!document.querySelector('[data-mobile-tree-sheet]')"
[ "$(sqlite3 "$DB" "SELECT coalesce(parent_id,'NULL') FROM nodes WHERE id='$TREE_ID';")" = "NULL" ] || fail "new tree node is not a root"

echo "== 4–5a. canvas Recent same-session chain forces linear and survives reload =="
open_mobile_overflow
ab click '[data-mobile-target="overflow-canvas"]'
wait_for_js "mobile canvas selected" "(() => { const saved=JSON.parse(localStorage.getItem('trellis-view:$SID') || 'null'); return saved?.viewMode === 'canvas' && Boolean(document.querySelector('[data-canvas-surface]')); })()"
open_mobile_drawer
click_recent_chain "第二棵树长文"
assert_mobile_landing "$ROOT2_ID" "same-session Recent exits canvas"
ab reload
assert_mobile_landing "$ROOT2_ID" "URL-backed active chain survives reload"

echo "== 4. scroll-hide remains available after Recent navigation =="
ab eval '(() => { const scroll=document.querySelector("[data-thread-scroll]"); if (!scroll || scroll.scrollHeight-scroll.clientHeight < 600) throw new Error("fixture cannot scroll"); scroll.scrollTop=0; scroll.dispatchEvent(new Event("scroll")); return true; })()' >/dev/null
wait_for_js "mobile header reset before scroll" "!document.querySelector('[data-mobile-header]')?.hasAttribute('data-header-hidden')"
wait_for_js "header and Composer hide on downward scroll" "(() => {
  const scroll=document.querySelector('[data-thread-scroll]');
  if (!scroll) return false;
  if (document.querySelector('[data-mobile-header]')?.dataset.headerHidden === 'true'
      && document.querySelector('[data-safe-area="linear-composer"]')?.dataset.composerHidden === 'true') return true;
  scroll.scrollTop=Math.min(scroll.scrollTop + 80, scroll.scrollHeight-scroll.clientHeight);
  scroll.dispatchEvent(new Event('scroll'));
  return false;
})()"
ab eval '(() => { const scroll=document.querySelector("[data-thread-scroll]"); scroll.scrollTop=Math.max(0, scroll.scrollTop-180); scroll.dispatchEvent(new Event("scroll")); return true; })()' >/dev/null
wait_for_js "header and Composer restore on upward scroll" "!document.querySelector('[data-mobile-header]')?.hasAttribute('data-header-hidden') && document.querySelector('[data-safe-area="linear-composer"]')?.dataset.composerHidden === 'false'"

echo "== 6. H-3: hidden linear chrome resets across canvas remount =="
wait_for_js "linear chrome hidden for H-3" "(() => {
  const scroll=document.querySelector('[data-thread-scroll]');
  if (!scroll) return false;
  if (document.querySelector('[data-mobile-header]')?.dataset.headerHidden === 'true') return true;
  scroll.scrollTop=Math.min(scroll.scrollTop + 100, scroll.scrollHeight-scroll.clientHeight);
  scroll.dispatchEvent(new Event('scroll'));
  return false;
})()"
ab eval 'document.querySelector("[data-mobile-header] [aria-label=\"更多功能\"]")?.click(); true' >/dev/null
wait_for_js "overflow opens from hidden header" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
ab click '[data-mobile-target="overflow-canvas"]'
wait_for_js "canvas clears hidden header state" "Boolean(document.querySelector('[data-canvas-surface]')) && !document.querySelector('[data-mobile-header]')?.hasAttribute('data-header-hidden')"
ab eval '(() => { const button=[...document.querySelectorAll("button")].find((element) => element.title === "切换到线性 thread"); if (!button) throw new Error("linear return button missing"); button.click(); return true; })()' >/dev/null
wait_for_js "linear remount chrome visible" "Boolean(document.querySelector('[data-thread-header]')) && document.querySelector('[data-safe-area="linear-composer"]')?.dataset.composerHidden === 'false' && !document.querySelector('[data-mobile-header]')?.hasAttribute('data-header-hidden')"

echo "== 7a. desktop anchored edit focuses the re-asked sibling =="
ab set viewport 1280 800
wait_for_js "desktop linear fixture" "innerWidth === 1280 && !document.querySelector('[data-mobile-header]') && Boolean(document.querySelector('[data-thread-header]'))"
if ! ab eval "Boolean([...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0))" | grep -q '^true$'; then
  ab click 'button[aria-label="展开侧栏"]'
fi
wait_for_js "desktop sidebar visible" "Boolean([...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0))"
click_recent_chain "预置锚点分支"
wait_for_js "desktop anchored chain selected" "new URL(location.href).searchParams.get('node') === '$ANCHORED_ID' && Boolean(document.querySelector('[data-thread-node-id=\"$ANCHORED_ID\"]')) && !document.querySelector('[data-canvas-surface]')"
ab eval "(() => {
  const button=document.querySelector('[data-thread-node-id=\"$ANCHORED_ID\"] [aria-label=\"编辑问题\"]');
  if (!button) throw new Error('desktop edit button missing');
  button.click();
  return true;
})()" >/dev/null
wait_for_js "desktop anchored edit input" "Boolean(document.querySelector('[data-thread-node-id=\"$ANCHORED_ID\"] textarea'))"
DESKTOP_EDIT_Q=桌面锚点节点重问聚焦验收
ab fill "[data-thread-node-id=\"$ANCHORED_ID\"] textarea" "$DESKTOP_EDIT_Q"
ab eval "(() => {
  const card = document.querySelector('[data-thread-node-id=\"$ANCHORED_ID\"]');
  const button = [...card.querySelectorAll('button')].find((element) => element.textContent?.includes('重问'));
  if (!button) throw new Error('desktop re-ask button missing');
  button.click();
  return true;
})()" >/dev/null
DESKTOP_EDIT_ID=$(wait_for_db_node "$DESKTOP_EDIT_Q")
wait_for_js "desktop edit new sibling active" "(() => {
  const saved=JSON.parse(localStorage.getItem('trellis-view:$SID') || 'null');
  return innerWidth === 1280
    && saved?.activeNodeId === '$DESKTOP_EDIT_ID'
    && saved?.viewMode === 'linear'
    && new URL(location.href).searchParams.get('node') === '$DESKTOP_EDIT_ID'
    && Boolean(document.querySelector('[data-thread-node-id=\"$DESKTOP_EDIT_ID\"]'))
    && !document.querySelector('[data-mobile-header]')
    && !document.querySelector('[data-canvas-surface]');
})()"
[ -n "$(sqlite3 "$DB" "SELECT parent_anchor_text FROM nodes WHERE id='$DESKTOP_EDIT_ID';")" ] || fail "desktop anchored edit lost parent_anchor_text"

echo "== 7b. desktop Recent stays in canvas and desktop header stays at top =="
ab eval '(() => { const button=[...document.querySelectorAll("[data-thread-header] button")].find((element) => element.textContent?.includes("画布")); if (!button) throw new Error("desktop canvas button missing"); button.click(); return true; })()' >/dev/null
wait_for_js "desktop canvas selected" "Boolean(document.querySelector('[data-canvas-surface]'))"
click_recent_chain "第二棵树长文"
wait_for_js "desktop Recent preserves canvas semantics" "new URL(location.href).searchParams.get('node') === '$ROOT2_ID' && Boolean(document.querySelector('[data-canvas-surface]'))"
ab eval --stdin <<'JS'
(() => {
  const header = document.querySelector('header');
  const rect = header?.getBoundingClientRect();
  if (!rect || Math.abs(rect.top) > 0.8) throw new Error('desktop header top=' + rect?.top);
  if (header.hasAttribute('data-header-hidden')) throw new Error('desktop header unexpectedly hidden');
  return { top: rect.top, height: rect.height, canvas: Boolean(document.querySelector('[data-canvas-surface]')) };
})()
JS

echo "== 5c. cross-session Recent retains existing linear behavior and URL =="
ab set viewport 390 844
wait_for_js "mobile shell restored after desktop baseline" "innerWidth === 390 && Boolean(document.querySelector('[data-mobile-header]'))"
open_mobile_drawer
click_recent_chain "跨会话 Recent 链"
wait_for_js "cross-session Recent target" "(() => {
  const url=new URL(location.href);
  const saved=JSON.parse(localStorage.getItem('trellis-view:$OTHER_SID') || 'null');
  return url.searchParams.get('session') === '$OTHER_SID'
    && url.searchParams.get('node') === '$OTHER_ID'
    && saved?.activeNodeId === '$OTHER_ID'
    && saved?.viewMode === 'linear'
    && Boolean(document.querySelector('[data-thread-node-id=\"$OTHER_ID\"]'))
    && !document.querySelector('[data-canvas-surface]');
})()"

echo "== 8. new-session screen clears the previous deep-link query =="
open_mobile_drawer
ab click '[role="dialog"] [data-mobile-target="drawer-new-session"]'
wait_for_js "new-session screen clears session and node query" "Boolean(document.querySelector('[data-mobile-target=new-session-input]')) && !new URL(location.href).searchParams.has('session') && !new URL(location.href).searchParams.has('node')"

echo "PASS: mobile and desktop branch focus, new-tree Cancel lifecycle, Recent chain mode, URL sync, H-3, and desktop baseline"
