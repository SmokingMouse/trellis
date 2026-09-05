#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3473
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-slim-shell
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
OUT="$H/out"
SESSION=mv-mobile-slim-shell
AUTH_PASS=mv-mobile-slim-shell-pass
AUTH_TOKEN=mv-mobile-slim-shell-token
SERVER_PID=
URL="$BASE/?session=mv-slim-session&node=mv-slim-f"

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

  # server.ts normally tears its child down with the gate. If it was killed
  # between spawn and handler setup, clean only the exact isolated command.
  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3473/ { print $1 }')
  if [ -n "$leftover_pids" ]; then
    kill $leftover_pids >/dev/null 2>&1 || true
  fi
  cleanup_wait=0
  while curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; do
    cleanup_wait=$((cleanup_wait + 1))
    if [ "$cleanup_wait" -ge 10 ]; then
      echo "WARN: port $PORT still responds after cleanup" >&2
      break
    fi
    sleep 1
  done
  exit "$cleanup_status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

print_page_diagnostics() {
  ab eval --stdin <<'JS' || true
(() => {
  const body = (document.body?.innerText || document.body?.textContent || '').slice(0, 300);
  return `location.href=${location.href}\ndocument.title=${document.title}\nbody[0:300]=${body}`;
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

assert_not_login() {
  if ! ab eval --stdin <<'JS'
(() => {
  if (location.pathname === '/login') throw new Error(`unexpected login page: ${location.href}`);
  return `authenticated path: ${location.pathname}`;
})()
JS
  then
    print_page_diagnostics
    return 1
  fi
}

for required_tool in bun agent-browser sqlite3 curl grep find ps awk; do
  command -v "$required_tool" >/dev/null 2>&1 || fail "missing required tool: $required_tool"
done
[ -f "$SOURCE_DB" ] || fail "source database missing: $SOURCE_DB"

# A named session owns a disposable browser profile. Closing it first prevents
# cookies/localStorage from a previous run from influencing the result.
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
rm -f "$DB" "$DB-shm" "$DB-wal"
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

# Insert after startup migration so the fixture cannot be interpreted as an
# abandoned live run. No model request is made anywhere in this script.
sqlite3 "$DB" <<'SQL'
INSERT INTO sessions
  (id,title,root_node_id,created_at,updated_at,context_mode,workspace_path,archived,require_approval,kind,title_source)
VALUES
  ('mv-slim-session','手机精简壳验收会话标题很长用于验证截断','mv-slim-root',1893456000000,1893456007000,'project','/tmp/mobile-slim-workspace',0,0,'user','default');
INSERT INTO nodes
  (id,session_id,parent_id,question,response,status,sibling_index,created_at,read_at,topic_label)
VALUES
  ('mv-slim-root','mv-slim-session',NULL,'手机首屏应该显示什么？','这是用于手机精简壳验收的根回答。正文必须保持可读，TreePanel 默认不得覆盖正文或输入框。','done',0,1893456000000,NULL,'手机首屏'),
  ('mv-slim-a','mv-slim-session','mv-slim-root','如何收纳桌面能力？','搜索、思维树、画布、工作区文件、笔记、导出、模式、模型、主题、任务和设置都进入 overflow。','done',0,1893456001000,NULL,'能力收纳'),
  ('mv-slim-b','mv-slim-session','mv-slim-a','TreePanel 怎么处理？','手机默认不挂载，打开后使用全屏 sheet，关闭回到线性阅读。','done',0,1893456002000,NULL,'树面板'),
  ('mv-slim-c','mv-slim-session','mv-slim-b','如何转桌面版？','写入本地标记后刷新，由统一的 useIsMobile 判定桌面布局，并提供回手机版入口。','done',0,1893456003000,NULL,'桌面模式'),
  ('mv-slim-d','mv-slim-session','mv-slim-a','画布如何落点？','进入手机画布后等待布局完成，再执行一次 fitView。','done',1,1893456004000,NULL,'画布落点'),
  ('mv-slim-e','mv-slim-session','mv-slim-d','为什么延迟？','React Flow 需要先测量卡片并完成 Dagre 布局。','done',0,1893456005000,NULL,'测量'),
  ('mv-slim-f','mv-slim-session','mv-slim-root','桌面会回归吗？','1280×800 下 Header 控件清单和尺寸保持不变。','done',1,1893456006000,NULL,'桌面零回归');
SQL

echo "== authenticate in a fresh iPhone 15 profile =="
ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"
assert_not_login

ab open "$URL"
wait_for_js "fixture linear composer" "Boolean(document.querySelector('textarea[placeholder*=\"继续对话\"]'))"
assert_not_login

echo "== M1: 390x844 slim Header =="
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const header = document.querySelector('[data-mobile-header]');
  assert(header, 'mobile header missing');
  assert(header.scrollWidth === header.clientWidth, `header overflow ${header.scrollWidth}/${header.clientWidth}`);
  const visible = (element) => element.offsetParent !== null;
  const buttons = [...header.querySelectorAll('button')].filter(visible);
  const labels = buttons.map((button) => button.getAttribute('aria-label'));
  assert(JSON.stringify(labels) === JSON.stringify(['会话列表', '更多功能']), `header buttons=${JSON.stringify(labels)}`);
  assert(buttons.every((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width >= 44 && rect.height >= 44;
  }), 'mobile header targets below 44px');
  assert(header.textContent.includes('手机精简壳验收会话标题'), `missing current title: ${header.textContent}`);
  return { width: header.clientWidth, scrollWidth: header.scrollWidth, buttons: labels };
})()
JS

ab click 'button[aria-label="更多功能"]'
wait_for_js "overflow bottom sheet" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const menu = document.querySelector('[data-mobile-overflow-menu]');
  assert(menu, 'overflow menu missing');
  const text = menu.textContent || '';
  for (const label of ['搜索', '思维树', '画布', '工作区文件', '笔记', '导出', '模式', '模型', '主题', '任务', '设置', '转桌面版']) {
    assert(text.includes(label), `overflow missing ${label}`);
  }
  const targets = [...menu.querySelectorAll('[data-mobile-target]')];
  assert(targets.length >= 12, `overflow target count=${targets.length}`);
  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    assert(rect.height >= 44, `${target.dataset.mobileTarget} height=${rect.height}`);
  }
  return { items: targets.map((target) => target.dataset.mobileTarget), minHeight: Math.min(...targets.map((target) => target.getBoundingClientRect().height)) };
})()
JS

echo "== M2: TreePanel absent by default, full-screen only on demand =="
ab set viewport 390 480
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(!document.querySelector('[data-mobile-tree-sheet]'), 'TreePanel mounted over 390x480 linear view');
  const textarea = document.querySelector('textarea[placeholder*="继续对话"]');
  assert(textarea, 'composer textarea missing');
  const rect = textarea.getBoundingClientRect();
  assert(rect.bottom <= innerHeight, `composer outside viewport: ${rect.bottom}/${innerHeight}`);
  return { treePanel: 'absent', composer: { top: rect.top, bottom: rect.bottom } };
})()
JS

ab set viewport 390 844
ab click '[data-mobile-target="overflow-tree"]'
wait_for_js "full-screen TreePanel" "Boolean(document.querySelector('[data-mobile-tree-sheet=\"open\"]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sheet = document.querySelector('[data-mobile-tree-sheet="open"]');
  const rect = sheet.getBoundingClientRect();
  assert(rect.left === 0 && rect.top === 0 && rect.width === innerWidth && rect.height === innerHeight, `TreePanel rect=${JSON.stringify(rect.toJSON())}`);
  assert(document.activeElement?.getAttribute('data-mobile-target') === 'tree-sheet-close', `TreePanel initial focus=${document.activeElement?.getAttribute('data-mobile-target')}`);
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
})()
JS
ab click 'button[aria-label="关闭思维树"]'
wait_for_js "TreePanel closed to linear" "!document.querySelector('[data-mobile-tree-sheet]') && Boolean(document.querySelector('textarea[placeholder*=\"继续对话\"]'))"

echo "== M11: overflow canvas entry performs delayed fitView =="
ab click 'button[aria-label="更多功能"]'
wait_for_js "overflow reopened" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
ab click '[data-mobile-target="overflow-canvas"]'
wait_for_js "canvas mounted" "Boolean(document.querySelector('[data-canvas-surface]'))"
wait_for_js "mobile canvas nodes fitted" "(() => { const nodes=[...document.querySelectorAll('.react-flow__node')]; return nodes.length===7 && nodes.every((node) => { const r=node.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=48 && r.bottom<=innerHeight; }); })()"
ab eval --stdin <<'JS'
(() => {
  const viewport = document.querySelector('.react-flow__viewport');
  const nodes = [...document.querySelectorAll('.react-flow__node')].map((node) => node.getBoundingClientRect());
  return {
    transform: viewport ? getComputedStyle(viewport).transform : null,
    bounds: {
      left: Math.min(...nodes.map((rect) => rect.left)),
      top: Math.min(...nodes.map((rect) => rect.top)),
      right: Math.max(...nodes.map((rect) => rect.right)),
      bottom: Math.max(...nodes.map((rect) => rect.bottom)),
    },
  };
})()
JS
ab click 'button[title="切换到线性 thread"]'
wait_for_js "linear view restored" "Boolean(document.querySelector('textarea[placeholder*=\"继续对话\"]'))"

echo "== desktop-mode marker and visible restore entry =="
ab eval 'localStorage.setItem("trellis-desktop-mode", "1"); "desktop marker set"'
ab reload
wait_for_js "forced desktop Header" "Boolean(document.querySelector('[data-mobile-target=\"restore-mobile-mode\"]'))"
assert_not_login
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(!document.querySelector('[data-mobile-header]'), 'slim header remained after desktop override');
  assert(localStorage.getItem('trellis-desktop-mode') === '1', 'desktop marker missing after reload');
  const linear = document.querySelector('[data-safe-area="linear-thread"]');
  const linearRect = linear.getBoundingClientRect();
  assert(linearRect.left === 0 && linearRect.width >= 382, `forced desktop linear rect=${JSON.stringify(linearRect.toJSON())}`);
  const hamburger = document.querySelector('[data-mobile-target="header-session-drawer"]');
  const hamburgerRect = hamburger.getBoundingClientRect();
  assert(hamburger.offsetParent !== null && hamburgerRect.width >= 44 && hamburgerRect.height >= 44, `forced desktop hamburger=${JSON.stringify(hamburgerRect.toJSON())}`);
  const restore = document.querySelector('[data-mobile-target="restore-mobile-mode"]');
  const rect = restore.getBoundingClientRect();
  assert(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, `restore entry offscreen: ${JSON.stringify(rect.toJSON())}`);
  return { marker: '1', linear: { left: linearRect.left, width: linearRect.width }, hamburger: { width: hamburgerRect.width, height: hamburgerRect.height }, restore: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
})()
JS
ab click '[data-mobile-target="header-session-drawer"]'
wait_for_js "forced desktop session drawer" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-close]'))"
ab eval --stdin <<'JS'
(() => {
  const close = document.querySelector('[role=dialog] [data-mobile-target="drawer-close"]');
  if (!close) throw new Error('forced desktop session drawer missing');
  const rect = close.closest('[role=dialog]').getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`forced desktop session drawer rect=${JSON.stringify(rect.toJSON())}`);
  return { width: rect.width, height: rect.height };
})()
JS
ab click '[role=dialog] [data-mobile-target="drawer-close"]'

echo "== clearing marker restores the mobile shell at 390x844 =="
ab eval 'localStorage.removeItem("trellis-desktop-mode"); "desktop marker cleared"'
ab reload
wait_for_js "mobile shell restored" "Boolean(document.querySelector('[data-mobile-header]')) && !document.querySelector('[data-mobile-target=\"restore-mobile-mode\"]')"
ab eval --stdin <<'JS'
(() => {
  if (localStorage.getItem('trellis-desktop-mode') !== null) throw new Error('desktop marker still present');
  const header = document.querySelector('[data-mobile-header]');
  return { restored: true, headerWidth: header.getBoundingClientRect().width };
})()
JS

echo "== 1280x800 desktop zero-regression baseline =="
ab set viewport 1280 800
ab reload
wait_for_js "normal desktop Header" "Boolean(document.querySelector('header button[aria-label=\"搜索\"]'))"
assert_not_login
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.8) => Math.abs(actual - expected) <= tolerance;
  const visible = (element) => element.offsetParent !== null;
  const label = (element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim().replace(/\s+/g, '').slice(0, 60);
  const header = document.querySelector('header');
  const headerRect = header.getBoundingClientRect();
  assert(near(headerRect.width, 1280) && near(headerRect.height, 48), `desktop header rect=${JSON.stringify(headerRect.toJSON())}`);
  assert(header.scrollWidth === header.clientWidth, `desktop header overflow ${header.scrollWidth}/${header.clientWidth}`);

  const controls = [...header.querySelectorAll('button,a')].filter(visible);
  const expected = [
    ['搜索', 30, 22],
    ['工作区文件', 30, 22],
    ['笔记', 30, 22],
    ['导出当前对话', 49.046875, 24],
    ['[Claude]Opus▾', 127.453125, 24],
    ['主题', 28, 28],
    ['自动化任务', 26.15625, 21],
    ['设置', 30, 22],
  ];
  assert(controls.length === expected.length, `desktop control count=${controls.length}`);
  controls.forEach((control, index) => {
    const rect = control.getBoundingClientRect();
    const [expectedLabel, width, height] = expected[index];
    assert(label(control) === expectedLabel, `desktop control ${index}: ${label(control)} != ${expectedLabel}`);
    assert(near(rect.width, width) && near(rect.height, height), `${expectedLabel} size=${rect.width}x${rect.height}`);
  });
  return { header: { width: headerRect.width, height: headerRect.height }, controls: expected.map(([name]) => name) };
})()
JS

ab screenshot "$OUT/1280x800-desktop.png"
echo "mobile-slim-shell verification passed"
