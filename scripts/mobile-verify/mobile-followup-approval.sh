#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3474
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-followup-approval
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
SESSION=mv-mobile-followup-approval
OUT="$H/out"
AUTH_PASS=mv-mobile-followup-approval-pass
AUTH_TOKEN=mv-mobile-followup-approval-token
SERVER_PID=

for tool in bun agent-browser sqlite3 curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: missing required tool: $tool" >&2
    exit 1
  fi
done

ab() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"
}

close_browser_session() {
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
  trap - 0
  close_browser_session
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    stop_try=0
    while kill -0 "$SERVER_PID" >/dev/null 2>&1 && [ "$stop_try" -lt 10 ]; do
      stop_try=$((stop_try + 1))
      sleep 1
    done
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$SERVER_PID" ]; then
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  port_try=0
  while curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; do
    port_try=$((port_try + 1))
    if [ "$port_try" -ge 10 ]; then
      echo "FAIL: port $PORT was not released" >&2
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
  wait_started=$(date +%s)
  while :; do
    if ab eval "$wait_expression" 2>/dev/null | grep -q '^true$'; then
      echo "✓ $wait_label"
      return 0
    fi
    wait_now=$(date +%s)
    if [ $((wait_now - wait_started)) -ge 90 ]; then
      echo "FAIL: timed out waiting for $wait_label" >&2
      print_page_diagnostics
      return 1
    fi
    sleep 1
  done
}

close_browser_session

if curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving HTTP" >&2
  exit 1
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
sqlite3 "$SOURCE_DB" ".backup $DB"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

(
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  exec bun --bun run start -- -p "$PORT"
) >"$H/server.log" 2>&1 &
SERVER_PID=$!

ready_try=0
until curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 "$BASE/__gate/health" 2>/dev/null | grep -q '"next":"ready"'; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "FAIL: isolated Trellis exited during startup" >&2
    tail -n 80 "$H/server.log" >&2
    exit 1
  fi
  ready_try=$((ready_try + 1))
  if [ "$ready_try" -ge 60 ]; then
    echo "FAIL: isolated Trellis did not become ready" >&2
    tail -n 80 "$H/server.log" >&2
    exit 1
  fi
  sleep 1
done

# Insert after startup: migrations resolve orphaned streaming rows. A done node
# with pending_interaction_json exercises the exact UI state without a model run.
sqlite3 "$DB" <<'SQL'
INSERT INTO sessions
  (id,title,root_node_id,created_at,updated_at,context_mode,archived,require_approval,kind,title_source)
VALUES
  ('mv-followup-reading-session','Mobile followup reading fixture','mv-followup-reading',1893456100000,1893456101000,'chat',0,0,'user','default'),
  ('mv-followup-wait-session','Mobile waiting approval fixture','mv-followup-wait-root',1893456200000,1893456202000,'chat',0,1,'user','default');

INSERT INTO nodes
  (id,session_id,parent_id,parent_anchor_text,question,response,status,sibling_index,created_at,read_at,pending_interaction_json)
VALUES
  ('mv-followup-reading','mv-followup-reading-session',NULL,NULL,'验证手机阅读与追问闭环','placeholder','done',0,1893456100000,NULL,NULL),
  ('mv-followup-wait-root','mv-followup-wait-session',NULL,NULL,'先阅读，再处理审批','等待项横幅应当把人带到待审批卡片。','done',0,1893456200000,NULL,NULL),
  ('mv-followup-permission','mv-followup-wait-session','mv-followup-wait-root',NULL,'运行安全的 fixture 命令','','done',0,1893456202000,NULL,'{"toolUseId":"mv-followup-tool","toolName":"Bash","input":{"command":"echo mobile-followup-fixture","description":"只用于手机审批布局验收"}}');

UPDATE nodes
SET response = (
  WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 90
  )
  SELECT group_concat('第 ' || n || ' 段：这是一段用于手机滚动、收起输入区和划词追问验收的长回答文字。', char(10) || char(10))
  FROM seq
)
WHERE id = 'mv-followup-reading';
SQL

echo "== authenticate isolated iPhone session =="
ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser state cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

READ_URL="$BASE/?session=mv-followup-reading-session&node=mv-followup-reading"
WAIT_URL="$BASE/?session=mv-followup-wait-session&node=mv-followup-wait-root"

ab open "$READ_URL"
wait_for_js "reading fixture composer" "Boolean(document.querySelector('[data-composer-state=compact] [data-composer-input]'))"

echo "== mobile Composer compact, hide, restore, expand =="
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const composer = document.querySelector('[data-mobile-composer]');
  const rail = document.querySelector('[data-safe-area="linear-composer"]');
  const input = document.querySelector('[data-composer-input]');
  assert(composer && rail && input, 'compact Composer fixture missing');
  const rect = composer.getBoundingClientRect();
  assert(composer.dataset.composerState === 'compact', `state=${composer.dataset.composerState}`);
  assert(rect.height <= 56, `compact height=${rect.height}`);
  assert(input.getAttribute('placeholder') === '追问…', `placeholder=${input.getAttribute('placeholder')}`);
  const visibleLabels = [...composer.querySelectorAll('button')]
    .filter((button) => button.getBoundingClientRect().width > 0)
    .map((button) => button.getAttribute('aria-label'));
  assert(JSON.stringify(visibleLabels) === JSON.stringify(['发送']), `compact buttons=${JSON.stringify(visibleLabels)}`);
  return { state: composer.dataset.composerState, height: rect.height, railBottom: rail.getBoundingClientRect().bottom };
})()
JS

ab eval --stdin <<'JS'
(() => {
  const scroll = document.querySelector('[data-thread-scroll]');
  if (!scroll || scroll.scrollHeight - scroll.clientHeight < 600) throw new Error('reading fixture is not long enough');
  scroll.scrollTop = 300;
  scroll.dispatchEvent(new Event('scroll'));
  return { top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight };
})()
JS
wait_for_js "compact Composer hidden after downward scroll" "document.querySelector('[data-safe-area=\"linear-composer\"]')?.getBoundingClientRect().top >= innerHeight - 0.5"

ab eval --stdin <<'JS'
(() => {
  const scroll = document.querySelector('[data-thread-scroll]');
  if (!scroll) throw new Error('thread scroll missing');
  scroll.scrollTop = 80;
  scroll.dispatchEvent(new Event('scroll'));
  return scroll.scrollTop;
})()
JS
wait_for_js "compact Composer restored after upward scroll" "document.querySelector('[data-safe-area=\"linear-composer\"]')?.getBoundingClientRect().top < innerHeight - 44"

ab click '[data-composer-input]'
wait_for_js "Composer expanded on focus" "document.querySelector('[data-mobile-composer]')?.dataset.composerState === 'expanded'"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const composer = document.querySelector('[data-mobile-composer]');
  const input = document.querySelector('[data-composer-input]');
  assert(composer && input, 'expanded Composer missing');
  const rect = composer.getBoundingClientRect();
  assert(rect.height >= 88, `expanded height=${rect.height}`);
  assert(document.activeElement === input, `active=${document.activeElement?.tagName}`);
  for (const label of ['添加附件', '画个草图', '发送']) {
    const button = composer.querySelector(`button[aria-label="${label}"]`);
    assert(button && button.getBoundingClientRect().height >= 44, `${label} missing or below 44px`);
  }
  return { state: composer.dataset.composerState, height: rect.height };
})()
JS

ab eval 'document.querySelector("[data-composer-input]").blur(); "blurred"'
wait_for_js "empty Composer collapsed after blur" "document.querySelector('[data-mobile-composer]')?.dataset.composerState === 'compact'"
ab click '[data-composer-input]'
wait_for_js "Composer re-expanded for keyboard viewport" "document.querySelector('[data-mobile-composer]')?.dataset.composerState === 'expanded'"

ab set viewport 390 480
ab fill '[data-composer-input]' 'verify only — do not send'
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const send = document.querySelector('[data-mobile-composer] button[aria-label="发送"]');
  const input = document.querySelector('[data-composer-input]');
  assert(send && input, 'keyboard Composer controls missing');
  const rect = send.getBoundingClientRect();
  assert(rect.bottom <= innerHeight, `send bottom=${rect.bottom}, viewport=${innerHeight}`);
  assert(document.activeElement === input, 'textarea lost focus in keyboard viewport');
  return { viewport: innerHeight, send: { top: rect.top, bottom: rect.bottom } };
})()
JS

echo "== mobile selection followup bottom sheet =="
ab set viewport 390 844
ab scrollintoview '[data-chat-node-id="mv-followup-reading"] p'
ab eval --stdin <<'JS'
(() => {
  const paragraph = document.querySelector('[data-chat-node-id="mv-followup-reading"] p');
  const text = paragraph?.firstChild;
  if (!text) throw new Error('reading paragraph text missing');
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
wait_for_js "collapsed BranchPopover" "Boolean(document.querySelector('[data-branch-popover] [data-mobile-target=branch-open]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const popover = document.querySelector('[data-branch-popover]');
  const primary = popover?.querySelector('[data-mobile-target="branch-open"]');
  const more = popover?.querySelector('[data-mobile-target="branch-more"]');
  assert(popover && primary && more, 'mobile BranchPopover primary actions missing');
  const r = popover.getBoundingClientRect();
  assert(r.left >= 0 && r.right <= innerWidth, `collapsed popover rect=${JSON.stringify(r.toJSON())}`);
  assert(primary.getBoundingClientRect().height >= 44 && more.getBoundingClientRect().height >= 44, 'collapsed branch target below 44px');
  return { left: r.left, right: r.right, width: r.width };
})()
JS
ab eval --stdin <<'JS'
(() => {
  const button = document.querySelector('[data-mobile-target="branch-open"]');
  if (!button) throw new Error('branch open missing');
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return 'expanded';
})()
JS
wait_for_js "expanded BranchPopover" "Boolean(document.querySelector('[data-branch-popover] textarea[placeholder^=\"进一步追问\"]'))"
ab fill '[data-branch-popover] textarea' 'verify followup only — do not send'
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const popover = document.querySelector('[data-branch-popover]');
  assert(popover, 'expanded BranchPopover missing');
  const r = popover.getBoundingClientRect();
  assert(r.left >= 0 && r.right <= innerWidth, `expanded popover horizontal rect=${JSON.stringify(r.toJSON())}`);
  assert(r.top >= 0 && r.bottom <= innerHeight, `expanded popover vertical rect=${JSON.stringify(r.toJSON())}`);
  for (const target of ['branch-attach', 'branch-cancel', 'branch-submit']) {
    const button = popover.querySelector(`[data-mobile-target="${target}"]`);
    const rect = button?.getBoundingClientRect();
    assert(rect && rect.width >= 44 && rect.height >= 44, `${target} below 44px`);
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
})()
JS
ab press Escape
wait_for_js "BranchPopover closed" "!document.querySelector('[data-branch-popover]')"

echo "== mobile waiting banner and approval card =="
ab open "$WAIT_URL"
wait_for_js "waiting banner" "Boolean(document.querySelector('[data-mobile-waiting-banner]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const banner = document.querySelector('[data-mobile-waiting-banner]');
  assert(banner?.textContent.includes('有 1 项等你处理'), `banner=${banner?.textContent}`);
  const rect = banner.getBoundingClientRect();
  assert(rect.height >= 44, `banner height=${rect.height}`);
  return { text: banner.textContent.trim(), height: rect.height };
})()
JS
ab click '[data-mobile-waiting-banner]'
wait_for_js "approval node selected" "Boolean(document.querySelector('[data-thread-node-id=mv-followup-permission] [data-mobile-interaction]'))"
wait_for_js "approval card in viewport" "(() => { const r=document.querySelector('[data-thread-node-id=mv-followup-permission] [data-mobile-interaction]')?.getBoundingClientRect(); return Boolean(r && r.top >= 0 && r.top < innerHeight && r.bottom > 0); })()"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const names = ['permission-allow', 'permission-always', 'permission-deny'];
  const rects = names.map((name) => {
    const button = document.querySelector(`[data-mobile-target="${name}"]`);
    const rect = button?.getBoundingClientRect();
    assert(rect && rect.width >= 44 && rect.height >= 44, `${name} below 44px`);
    return { name, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  assert(rects[1].top - rects[0].bottom >= 12, `allow/always gap=${rects[1].top - rects[0].bottom}`);
  assert(rects[2].top - rects[1].bottom >= 20, `always/deny gap=${rects[2].top - rects[1].bottom}`);
  const rail = document.querySelector('[data-safe-area="linear-composer"]');
  assert(rail?.dataset.composerHidden === 'false', `waiting Composer hidden=${rail?.dataset.composerHidden}`);
  return rects;
})()
JS

echo "== desktop 1280x800 unchanged baseline =="
ab set viewport 1280 800
ab open "$READ_URL"
wait_for_js "desktop reading fixture" "Boolean(document.querySelector('[data-composer-input]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.6) => Math.abs(actual - expected) <= tolerance;
  const rail = document.querySelector('[data-safe-area="linear-composer"]');
  const composer = document.querySelector('[data-mobile-composer]');
  const input = document.querySelector('[data-composer-input]');
  assert(rail && composer && input, 'desktop Composer missing');
  assert(composer.dataset.composerState === 'expanded', `desktop state=${composer.dataset.composerState}`);
  const labels = [...composer.querySelectorAll('button')]
    .filter((button) => button.getBoundingClientRect().width > 0)
    .map((button) => button.getAttribute('aria-label'));
  assert(JSON.stringify(labels) === JSON.stringify(['添加附件', '画个草图', '发送']), `desktop buttons=${JSON.stringify(labels)}`);
  const rr = rail.getBoundingClientRect();
  assert(near(rr.left, 210) && near(rr.top, 729) && near(rr.width, 1070) && near(rr.height, 71), `desktop Composer rect=${JSON.stringify(rr.toJSON())}`);
  assert(near(parseFloat(getComputedStyle(input).fontSize), 14), `desktop input font=${getComputedStyle(input).fontSize}`);
  return { rail: { left: rr.left, top: rr.top, width: rr.width, height: rr.height }, labels };
})()
JS

ab scrollintoview '[data-chat-node-id="mv-followup-reading"] p'
ab eval --stdin <<'JS'
(() => {
  const paragraph = document.querySelector('[data-chat-node-id="mv-followup-reading"] p');
  const text = paragraph?.firstChild;
  if (!text) throw new Error('desktop branch paragraph missing');
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
wait_for_js "desktop collapsed BranchPopover" "Boolean(document.querySelector('[data-mobile-target=branch-open]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const specs = [
    ['branch-open', 128.05, 33.5],
    ['branch-note', 63.05, 33.5],
  ];
  return specs.map(([target, width, height]) => {
    const rect = document.querySelector(`[data-mobile-target="${target}"]`)?.getBoundingClientRect();
    assert(rect && Math.abs(rect.width - width) <= 0.25 && Math.abs(rect.height - height) <= 0.25, `${target}=${rect?.width}x${rect?.height}`);
    return { target, width: rect.width, height: rect.height };
  });
})()
JS
ab eval --stdin <<'JS'
(() => {
  const button = document.querySelector('[data-mobile-target="branch-open"]');
  if (!button) throw new Error('desktop branch open missing');
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return 'expanded';
})()
JS
wait_for_js "desktop expanded BranchPopover" "Boolean(document.querySelector('[data-mobile-target=branch-submit]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const specs = [
    ['branch-attach', 31, 20],
    ['branch-cancel', 40, 20],
    ['branch-submit', 44, 20],
  ];
  return specs.map(([target, width, height]) => {
    const rect = document.querySelector(`[data-mobile-target="${target}"]`)?.getBoundingClientRect();
    assert(rect && Math.abs(rect.width - width) <= 0.25 && Math.abs(rect.height - height) <= 0.25, `${target}=${rect?.width}x${rect?.height}`);
    return { target, width: rect.width, height: rect.height };
  });
})()
JS
ab press Escape

ab open "$WAIT_URL"
wait_for_js "desktop InteractionForm" "Boolean(document.querySelector('[data-mobile-interaction]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(!document.querySelector('[data-mobile-waiting-banner]'), 'waiting banner leaked onto desktop');
  const specs = [
    ['permission-allow', 76.39, 34.75],
    ['permission-always', 128.39, 36.75],
    ['permission-deny', 78.39, 36.75],
  ];
  return specs.map(([target, width, height]) => {
    const rect = document.querySelector(`[data-mobile-target="${target}"]`)?.getBoundingClientRect();
    assert(rect && Math.abs(rect.width - width) <= 0.25 && Math.abs(rect.height - height) <= 0.25, `${target}=${rect?.width}x${rect?.height}`);
    return { target, width: rect.width, height: rect.height };
  });
})()
JS

echo "PASS: mobile followup, approval, waiting banner, compact Composer, and desktop baselines"
