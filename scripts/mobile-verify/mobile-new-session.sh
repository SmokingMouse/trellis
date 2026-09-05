#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3475
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-new-session
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
OUT="$H/out"
SESSION=mv-mobile-new-session
AUTH_PASS=mv-mobile-new-session-pass
AUTH_TOKEN=mv-mobile-new-session-token
SERVER_PID=

fail() {
  echo "mobile-new-session: $*" >&2
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

  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3475/ { print $1 }')
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
  exit "$cleanup_status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

print_page_diagnostics() {
  ab eval --stdin <<'JS' || true
(() => {
  const body = (document.body?.innerText || document.body?.textContent || '').slice(0, 500);
  return `location.href=${location.href}\ndocument.title=${document.title}\nbody[0:500]=${body}`;
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

for required_tool in bun agent-browser sqlite3 curl grep find ps awk; do
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

# Insert after startup migration. This fixture is read-only in the browser;
# the script never clicks a send/start action and therefore never spends model quota.
sqlite3 "$DB" <<'SQL'
INSERT INTO sessions
  (id,title,root_node_id,created_at,updated_at,context_mode,workspace_path,archived,require_approval,kind,title_source)
VALUES
  ('mv-new-session-fixture','新树文案与键盘态验收','mv-new-session-root',1893456010000,1893456010000,'chat',NULL,0,0,'user','default');
INSERT INTO nodes
  (id,session_id,parent_id,question,response,status,sibling_index,created_at,read_at,topic_label)
VALUES
  ('mv-new-session-root','mv-new-session-fixture',NULL,'新树和新会话有什么区别？','这是只读验收节点，用来打开新树 modal，不会发起模型请求。','done',0,1893456010000,NULL,'新树区别');
SQL

echo "== authenticate isolated iPhone session =="
ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login' && Boolean(document.querySelector('button[aria-label=\"会话列表\"]'))"

echo "== drawer: new session is primary; Attach CLI is advanced =="
ab click 'button[aria-label="会话列表"]'
wait_for_js "mobile session drawer" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-new-session]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const newSession = document.querySelector('[role=dialog] [data-mobile-target="drawer-new-session"]');
  const drawer = newSession?.closest('[role=dialog]');
  assert(drawer && newSession, 'mobile session drawer target missing');
  const advanced = drawer.querySelector('[data-mobile-target="drawer-advanced"]');
  const visibleAttach = [...drawer.querySelectorAll('[data-mobile-target="drawer-attach"]')]
    .some((element) => element.offsetParent !== null);
  const nr = newSession.getBoundingClientRect();
  const ar = advanced.getBoundingClientRect();
  assert(nr.width >= 44 && nr.height >= 44, `new-session target=${nr.width}x${nr.height}`);
  assert(ar.width >= 44 && ar.height >= 44, `advanced target=${ar.width}x${ar.height}`);
  assert(!visibleAttach, 'Attach CLI leaked into the primary drawer region');
  return { newSession: nr.toJSON(), advanced: ar.toJSON(), attach: 'collapsed' };
})()
JS
ab click '[role="dialog"] [data-mobile-target="drawer-advanced"]'
wait_for_js "advanced Attach CLI" "[...document.querySelectorAll('[role=dialog] [data-mobile-target=drawer-attach]')].some((element) => element.offsetParent !== null)"
ab eval --stdin <<'JS'
(() => {
  const attach = [...document.querySelectorAll('[role=dialog] [data-mobile-target="drawer-attach"]')]
    .find((element) => element.offsetParent !== null);
  const rect = attach.getBoundingClientRect();
  if (rect.width < 44 || rect.height < 44) throw new Error(`Attach CLI target=${rect.width}x${rect.height}`);
  return rect.toJSON();
})()
JS
ab click '[role="dialog"] [data-mobile-target="drawer-new-session"]'
wait_for_js "new session screen" "Boolean(document.querySelector('[data-mobile-target=new-session-input]'))"

echo "== 390x480: compact first screen =="
ab set viewport 390 480
wait_for_js "390x480 layout" "innerWidth === 390 && innerHeight === 480"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const root = document.documentElement;
  const input = document.querySelector('[data-mobile-target="new-session-input"]');
  const panel = input.closest('.max-w-2xl');
  const text = panel.innerText;
  assert(root.scrollWidth === innerWidth, `document overflow ${root.scrollWidth}/${innerWidth}`);
  for (const forbidden of ['增强模式', '历史深度', '专注写作']) {
    assert(!text.includes(forbidden), `first screen leaked ${forbidden}`);
  }
  for (const hiddenStarter of ['用类比讲清楚 TCP 和 UDP 的区别', '从背景材料开始']) {
    assert(!text.includes(hiddenStarter), `starter template leaked: ${hiddenStarter}`);
  }
  const intro = [...panel.querySelectorAll('p')].find((element) => element.textContent?.includes('想深入探索什么'));
  assert(intro && visible(intro), 'starting hint is not visible');
  const required = ['new-session-input', 'new-session-attach', 'new-session-start'];
  const measured = required.map((target) => {
    const element = panel.querySelector(`[data-mobile-target="${target}"]`);
    assert(element && visible(element), `${target} is not visible`);
    const rect = element.getBoundingClientRect();
    assert(rect.width >= 44 && rect.height >= 44, `${target}=${rect.width}x${rect.height}`);
    assert(rect.bottom <= innerHeight, `${target} below fold: ${rect.bottom}/${innerHeight}`);
    return { target, width: rect.width, height: rect.height, bottom: rect.bottom };
  });
  const visibleControls = [...document.querySelectorAll('button,a,input,textarea,select')].filter(visible);
  for (const control of visibleControls) {
    const rect = control.getBoundingClientRect();
    assert(rect.left >= 0 && rect.right <= innerWidth, `visible control overflow: ${control.outerHTML.slice(0, 120)} rect=${JSON.stringify(rect.toJSON())}`);
  }
  const summary = panel.querySelector('[data-mobile-target="new-session-config-summary"]');
  assert(summary && summary.getBoundingClientRect().height === 44, 'mode/model summary is not a one-line 44px target');
  return { viewport: [innerWidth, innerHeight], documentWidth: [root.clientWidth, root.scrollWidth], required: measured, visibleControlCount: visibleControls.length };
})()
JS
ab screenshot "$OUT/390x480-first-screen.png"

echo "== more settings: advanced controls and starters remain configurable =="
ab click '[data-mobile-target="new-session-more-settings"]'
wait_for_js "more settings sheet" "Boolean(document.querySelector('[data-mobile-target=new-session-settings-sheet]'))"
ab eval --stdin <<'JS'
(() => {
  const sheet = document.querySelector('[data-mobile-target="new-session-settings-sheet"]');
  const text = sheet.innerText;
  for (const expected of ['增强模式', '历史深度', '专注写作', '快捷键', '草图', '起步模板', '用类比讲清楚 TCP 和 UDP 的区别', '从背景材料开始']) {
    if (!text.includes(expected)) throw new Error(`more settings missing ${expected}`);
  }
  return text.slice(0, 500);
})()
JS
ab screenshot "$OUT/390x480-more-settings.png"
ab click 'button[aria-label="关闭更多设置"]'
wait_for_js "more settings closed" "!document.querySelector('[data-mobile-target=new-session-settings-sheet]')"

echo "== project mode: mode/workspace use full-width rows at both phone heights =="
ab eval --stdin <<'JS'
(() => {
  localStorage.setItem('trellis-mode', 'project');
  localStorage.setItem('trellis-workspace', '/Users/smokingmouse/python/learning/trellis/worktrees/feature-with-a-very-long-workspace-name');
  location.reload();
  return true;
})()
JS
wait_for_js "project mode home" "Boolean(document.querySelector('button[aria-label=\"会话列表\"]'))"
ab click 'button[aria-label="会话列表"]'
wait_for_js "project drawer" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-new-session]'))"
ab click '[role="dialog"] [data-mobile-target="drawer-new-session"]'
wait_for_js "project new session" "document.querySelector('[data-mobile-target=new-session-config-summary]')?.textContent?.includes('Project') === true"
ab click '[data-mobile-target="new-session-config-summary"]'
wait_for_js "project settings sheet" "Boolean(document.querySelector('[data-mobile-target=new-session-mode-config] [data-mobile-target=workspace-select]'))"

for viewport_height in 844 480; do
  ab set viewport 390 "$viewport_height"
  wait_for_js "390x$viewport_height project layout" "innerWidth === 390 && innerHeight === $viewport_height"
  ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const root = document.documentElement;
  const mode = document.querySelector('[data-mobile-target="new-session-mode-config"]');
  const controls = [...mode.querySelectorAll('button')].filter((element) => element.offsetParent !== null);
  assert(root.scrollWidth === innerWidth, `document overflow ${root.scrollWidth}/${innerWidth}`);
  assert(mode.getBoundingClientRect().right <= innerWidth, `mode area overflow ${JSON.stringify(mode.getBoundingClientRect().toJSON())}`);
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    assert(rect.left >= 0 && rect.right <= innerWidth, `mode control overflow ${JSON.stringify(rect.toJSON())}`);
    assert(rect.width >= 44 && rect.height >= 44, `mode control too small ${rect.width}x${rect.height}`);
  }
  const visibleControls = [...document.querySelectorAll('button,a,input,textarea,select')].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden';
  });
  for (const control of visibleControls) {
    const rect = control.getBoundingClientRect();
    assert(rect.left >= 0 && rect.right <= innerWidth, `visible control overflow ${JSON.stringify(rect.toJSON())}`);
  }
  const workspace = mode.querySelector('[data-mobile-target="workspace-select"]');
  assert(workspace.textContent.includes('…'), `workspace path is not middle-ellipsized: ${workspace.textContent}`);
  assert(workspace.title.endsWith('feature-with-a-very-long-workspace-name'), `full workspace path missing from title: ${workspace.title}`);
  return { viewport: [innerWidth, innerHeight], mode: mode.getBoundingClientRect().toJSON(), controls: controls.map((element) => element.getBoundingClientRect().toJSON()), visibleControlCount: visibleControls.length };
})()
JS
done
ab screenshot "$OUT/390x480-project-workspace.png"
ab click 'button[aria-label="关闭更多设置"]'

echo "== 390x480: new-tree modal copy and keyboard-safe layout =="
ab open "$BASE/?session=mv-new-session-fixture&node=mv-new-session-root"
wait_for_js "fixture composer" "Boolean(document.querySelector('textarea[placeholder*=\"继续对话\"]'))"
ab click 'button[aria-label="更多功能"]'
wait_for_js "mobile overflow" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
ab click '[data-mobile-target="overflow-tree"]'
wait_for_js "mobile tree sheet" "Boolean(document.querySelector('[data-mobile-tree-sheet=open] [data-mobile-target=new-tree-open]'))"
ab click '[data-mobile-target="new-tree-open"]'
wait_for_js "new-tree modal" "Boolean(document.querySelector('[data-mobile-target=new-tree-start]'))"
ab fill 'textarea[placeholder^="为这棵新树"]' '只填写，不提交'
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const shell = document.querySelector('[data-safe-area="modal-shell"]');
  const modal = shell.querySelector('[role="dialog"]');
  const text = modal.innerText;
  for (const expected of ['新树', '不会创建新会话', '侧栏的「新会话」']) {
    assert(text.includes(expected), `new-tree copy missing ${expected}`);
  }
  const rect = modal.getBoundingClientRect();
  assert(rect.top >= 0 && rect.bottom <= innerHeight, `new-tree modal clipped ${JSON.stringify(rect.toJSON())}`);
  for (const target of ['new-tree-close', 'new-tree-cancel', 'new-tree-start']) {
    const button = modal.querySelector(`[data-mobile-target="${target}"]`);
    const buttonRect = button.getBoundingClientRect();
    assert(buttonRect.width >= 44 && buttonRect.height >= 44, `${target}=${buttonRect.width}x${buttonRect.height}`);
    assert(buttonRect.bottom <= innerHeight, `${target} clipped at ${buttonRect.bottom}/${innerHeight}`);
  }
  const textarea = modal.querySelector('textarea');
  const textareaRect = textarea.getBoundingClientRect();
  assert(textareaRect.top >= rect.top && textareaRect.bottom <= rect.bottom, `new-tree textarea clipped ${JSON.stringify(textareaRect.toJSON())}`);
  return { viewport: [innerWidth, innerHeight], modal: rect.toJSON(), textarea: textareaRect.toJSON() };
})()
JS
ab screenshot "$OUT/390x480-new-tree-keyboard.png"
ab click '[data-mobile-target="new-tree-close"]'

echo "== /settings/prefs: labels stack above controls on phone =="
ab set viewport 390 844
ab open "$BASE/settings/prefs"
wait_for_js "prefs controls" "document.querySelectorAll('select').length >= 4"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const label = [...document.querySelectorAll('div')]
    .find((element) => element.children.length === 0 && element.textContent?.trim() === '上下文历史深度');
  assert(label, '上下文历史深度 label missing');
  const labelColumn = label.parentElement;
  const row = labelColumn.parentElement;
  const select = row.querySelector('select');
  const labelRect = label.getBoundingClientRect();
  const selectRect = select.getBoundingClientRect();
  assert(getComputedStyle(row).flexDirection === 'column', `prefs row flex-direction=${getComputedStyle(row).flexDirection}`);
  assert(labelRect.width >= 100 && labelRect.height < 40, `label collapsed vertically ${JSON.stringify(labelRect.toJSON())}`);
  assert(selectRect.top >= labelColumn.getBoundingClientRect().bottom, `select did not stack below label: ${JSON.stringify(selectRect.toJSON())}`);
  assert(selectRect.width >= row.getBoundingClientRect().width - 1, `select is not full-width: ${selectRect.width}/${row.getBoundingClientRect().width}`);
  assert(document.documentElement.scrollWidth === innerWidth, `prefs overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
  return { label: labelRect.toJSON(), select: selectRect.toJSON(), rowDirection: getComputedStyle(row).flexDirection };
})()
JS
ab screenshot "$OUT/390x844-settings-prefs.png"

echo "== 1280x800: QuestionInput desktop baseline unchanged =="
ab eval --stdin <<'JS'
(() => {
  localStorage.setItem('trellis-mode', 'chat');
  localStorage.removeItem('trellis-workspace');
  localStorage.removeItem('trellis-desktop-mode');
  localStorage.setItem('trellis-provider', 'claude-opus');
  location.href = '/';
  return true;
})()
JS
ab set viewport 1280 800
wait_for_js "desktop app shell" "innerWidth === 1280 && Boolean(document.querySelector('[data-mobile-target=drawer-new-session]'))"
ab click '[data-mobile-target="drawer-new-session"]'
wait_for_js "desktop new session" "Boolean(document.querySelector('textarea[placeholder^=\"例如：\"]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.8) => Math.abs(actual - expected) <= tolerance;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textarea = document.querySelector('textarea[placeholder^="例如："]');
  const panel = textarea.closest('.max-w-2xl');
  const panelRect = panel.getBoundingClientRect();
  const controls = [...panel.querySelectorAll('button,input,textarea')].filter(visible);
  const expected = [
    ['BUTTON', 60.25, 26],
    ['BUTTON', 74.203125, 26],
    ['BUTTON', 156.828125, 32.75],
    ['BUTTON', 98, 32.75],
    ['TEXTAREA', 670, 129.5],
    ['BUTTON', 115.1875, 16],
    ['BUTTON', 82.375, 16],
    ['BUTTON', 77.8125, 24],
    ['BUTTON', 59, 24],
    ['BUTTON', 59, 24],
    ['BUTTON', 88, 32],
    ['BUTTON', 215.390625, 32.75],
    ['BUTTON', 209.484375, 32.75],
    ['BUTTON', 213.109375, 32.75],
    ['BUTTON', 151, 32.75],
    ['BUTTON', 252.671875, 38],
  ];
  assert(near(panelRect.width, 672) && near(panelRect.height, 590.75), `desktop panel=${JSON.stringify(panelRect.toJSON())}`);
  assert(controls.length === expected.length, `desktop control count=${controls.length}/${expected.length}`);
  controls.forEach((control, index) => {
    const rect = control.getBoundingClientRect();
    const [tag, width, height] = expected[index];
    assert(control.tagName === tag, `desktop control ${index} tag=${control.tagName}/${tag}`);
    assert(near(rect.width, width) && near(rect.height, height), `desktop control ${index}=${rect.width}x${rect.height}, expected ${width}x${height}`);
  });
  assert(!document.querySelector('[data-mobile-target="new-session-config-summary"]'), 'mobile summary mounted on desktop');
  assert(!document.querySelector('[data-mobile-target="new-session-more-settings"]'), 'mobile settings trigger mounted on desktop');
  return { panel: panelRect.toJSON(), controls: expected };
})()
JS
ab screenshot "$OUT/1280x800-desktop-new-session.png"

echo "PASS: mobile new-session shell, project workspace rows, new-tree copy, prefs stacking, and desktop baseline"
