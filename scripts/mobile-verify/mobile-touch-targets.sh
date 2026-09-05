#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3472
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-touch-targets
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
SESSION=mv-mobile-touch-targets
OUT="$H/out"
AUTH_PASS=mv-mobile-touch-targets-pass
AUTH_TOKEN=mv-mobile-touch-targets-token
SERVER_PID=

for tool in bun agent-browser sqlite3 curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: missing required tool: $tool"
    exit 1
  fi
done

close_browser_session() {
  close_try=0
  while [ "$close_try" -lt 5 ]; do
    if AGENT_BROWSER_SESSION="$SESSION" agent-browser close >/dev/null 2>&1; then
      return 0
    fi
    close_try=$((close_try + 1))
    sleep 1
  done
  echo "WARN: could not close agent-browser session $SESSION after 5 attempts" >&2
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

ab() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"
}

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
  wait_started=$(date +%s)
  while :; do
    if ab eval "$wait_expression" 2>/dev/null | grep -q '^true$'; then
      echo "✓ $wait_label"
      return 0
    fi
    wait_now=$(date +%s)
    if [ $((wait_now - wait_started)) -ge 90 ]; then
      echo "FAIL: timed out waiting for $wait_label"
      print_page_diagnostics
      return 1
    fi
    sleep 1
  done
}

assert_not_login() {
  if ! ab eval --stdin <<'JS'
(() => {
  if (location.pathname === '/login') {
    throw new Error(`unexpected login page: ${location.href}`);
  }
  return `authenticated path: ${location.pathname}`;
})()
JS
  then
    echo "FAIL: authentication was lost after navigation"
    print_page_diagnostics
    return 1
  fi
}

reauth_if_needed() {
  if ab eval "location.pathname === '/login'" 2>/dev/null | grep -q '^true$'; then
    echo "↻ authentication expired; signing in again"
    ab wait '#pw'
    ab fill '#pw' "$AUTH_PASS"
    ab click 'button[type="submit"]'
    ab wait --fn "location.pathname !== '/login'"
  fi
}

wait_for_fixture_node() {
  fixture_started=$(date +%s)
  while :; do
    if ab eval 'Boolean(document.querySelector("[data-thread-node-id=mv-touch-done]"))' 2>/dev/null | grep -q true; then
      echo "✓ fixture node ready"
      return 0
    fi
    fixture_now=$(date +%s)
    if [ $((fixture_now - fixture_started)) -ge 90 ]; then
      echo "FAIL: fixture node [data-thread-node-id=\"mv-touch-done\"] did not appear within 90s"
      print_page_diagnostics
      return 1
    fi
    sleep 1
  done
}

# Always dispose a stale named session before touching the app instance. This
# also makes a clean-shell rerun independent of browser daemon state left by a
# previous interrupted verification.
close_browser_session

if curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving HTTP"
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

i=0
until curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 "$BASE/__gate/health" 2>/dev/null | grep -q '"next":"ready"'; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "FAIL: isolated Trellis exited during startup"
    tail -n 80 "$H/server.log"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "FAIL: isolated Trellis did not become ready"
    tail -n 80 "$H/server.log"
    exit 1
  fi
  sleep 1
done

# Startup migration deliberately resolves orphaned streaming nodes. Inject the
# fixture after readiness and keep node.status=done so no absent in-memory run
# can reap it; pending_interaction_json is the UI's waiting-state source of
# truth and renders the same Permission / Ask cards as a paused live run.
sqlite3 "$DB" <<'SQL'
INSERT INTO sessions
  (id,title,root_node_id,created_at,updated_at,context_mode,archived,require_approval,kind,title_source)
VALUES
  ('mv-touch-permission-session','Mobile touch permission fixture','mv-touch-done',1893456000000,1893456002000,'chat',0,1,'user','default'),
  ('mv-touch-ask-session','Mobile touch ask fixture','mv-touch-ask',1893456001000,1893456003000,'chat',0,0,'user','default');
INSERT INTO nodes
  (id,session_id,parent_id,parent_anchor_text,question,response,status,sibling_index,created_at,read_at,pending_interaction_json)
VALUES
  ('mv-touch-done','mv-touch-permission-session',NULL,NULL,'Touch target baseline','这是一段用于选择与分支验证的回答文本。手机端核心操作应当有足够大的触控区域。

```ts
const touchTarget = 44;
console.log(touchTarget);
```

最后一段回答用于显示复制、标为已读与分支动作。','done',0,1893456000000,NULL,NULL),
  ('mv-touch-permission','mv-touch-permission-session','mv-touch-done',NULL,'Run a harmless local check','','done',0,1893456002000,NULL,'{"toolUseId":"mv-permission-tool","toolName":"Bash","input":{"command":"echo touch-target-fixture","description":"Mobile touch fixture"}}'),
  ('mv-touch-ask','mv-touch-ask-session',NULL,NULL,'Choose a verification mode','','done',0,1893456001000,NULL,'{"toolUseId":"mv-ask-tool","toolName":"AskUserQuestion","input":{"questions":[{"header":"Touch","question":"Which target should be verified?","options":[{"label":"Core controls"},{"label":"All controls"}],"multiSelect":false}]}}');
SQL

ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
ab wait '#pw'
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser state cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
ab wait --fn "location.pathname !== '/login'"
assert_not_login

ab open "$BASE/?session=mv-touch-permission-session&node=mv-touch-permission"
wait_for_js "mobile app shell" "Boolean(document.querySelector('header'))"
ab eval --stdin <<'JS'
(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('trellis-view:mv-touch-permission-session', JSON.stringify({
    activeNodeId: 'mv-touch-permission',
    viewMode: 'linear',
  }));
  location.reload();
  return 'mobile fixture ready';
})()
JS
assert_not_login
wait_for_fixture_node

echo "== mobile 390x844: session drawer =="
ab click 'button[aria-label="会话列表"]'
wait_for_js "session drawer" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-close]'))"
ab click '[role="dialog"] [data-mobile-target="drawer-advanced"]'
wait_for_js "drawer advanced actions" "Boolean(document.querySelector('[role=dialog] [data-mobile-target=drawer-attach]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['drawer new session', '[role="dialog"] [data-mobile-target="drawer-new-session"]'],
    ['drawer close', '[role="dialog"] [data-mobile-target="drawer-close"]'],
    ['drawer advanced', '[role="dialog"] [data-mobile-target="drawer-advanced"]'],
    ['drawer attach', '[role="dialog"] [data-mobile-target="drawer-attach"]'],
    ['drawer session rows', '[role="dialog"] [data-mobile-target="session-row"]', true],
    ['drawer chain rows', '[role="dialog"] [data-mobile-target="session-chain-row"]', true],
  ];
  const results = [];
  for (const [name, selector, all] of specs) {
    const elements = [...document.querySelectorAll(selector)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (elements.length === 0) throw new Error(`${name}: missing ${selector}`);
    const measured = (all ? elements : elements.slice(0, 1)).map((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) {
        throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
      }
      return { width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
    });
    results.push({ name, selector, count: measured.length, minWidth: Math.min(...measured.map((r) => r.width)), minHeight: Math.min(...measured.map((r) => r.height)) });
  }
  return JSON.stringify(results, null, 2);
})()
JS
ab click '[role="dialog"] [data-mobile-target="drawer-close"]'
wait_for_js "session drawer closed" "!document.querySelector('[role=dialog] [data-mobile-target=drawer-close]')"

ab scrollintoview '[data-thread-node-id="mv-touch-done"]'
wait_for_js "answer actions visible" "Boolean(document.querySelector('[data-thread-node-id=mv-touch-done] [data-mobile-target=node-branch]'))"
echo "== mobile 390x844: approval, code, answer actions =="
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['permission allow', '[data-mobile-target="permission-allow"]'],
    ['permission always', '[data-mobile-target="permission-always"]'],
    ['permission deny', '[data-mobile-target="permission-deny"]'],
    ['code copy', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="code-copy"]'],
    ['mark read toggle', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="node-read-toggle"]'],
    ['branch from node', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="node-branch"]'],
    ['delete node', '[data-thread-node-id="mv-touch-permission"] [data-mobile-target="node-delete"]'],
    ['response copy full', '[data-thread-node-id="mv-touch-done"] [data-mobile-response-actions] button[aria-label="复制全文"]'],
    ['response more', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-more"]'],
  ];
  const results = specs.map(([name, selector]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) {
      throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
    }
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  });
  return JSON.stringify(results, null, 2);
})()
JS
ab click '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-more"]'
wait_for_js "mobile response overflow" "Boolean(document.querySelector('[data-mobile-response-menu]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['response regenerate', '[data-mobile-response-menu] [data-mobile-target="response-regenerate"]'],
    ['response card image', '[data-mobile-response-menu] [data-mobile-target="response-card-image"]'],
  ];
  return JSON.stringify(specs.map(([name, selector]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
    return { name, width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  }), null, 2);
})()
JS
ab click '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-more"]'
wait_for_js "mobile response overflow closed" "!document.querySelector('[data-mobile-response-menu]')"
ab screenshot "$OUT/mobile-permission.png" >/dev/null

echo "== mobile 390x844: BranchPopover collapsed =="
ab eval --stdin <<'JS'
(() => {
  const p = document.querySelector('[data-chat-node-id="mv-touch-done"] p');
  const text = p?.firstChild;
  if (!text) throw new Error('fixture paragraph missing');
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(12, text.textContent.length));
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return range.toString();
})()
JS
wait_for_js "branch selection actions" "Boolean(document.querySelector('[data-mobile-target=branch-open]')) && Boolean(document.querySelector('[data-mobile-target=branch-note]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['branch selection open', '[data-mobile-target="branch-open"]'],
    ['branch more', '[data-mobile-target="branch-more"]'],
  ];
  const results = specs.map(([name, selector]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  });
  return JSON.stringify(results, null, 2);
})()
JS
ab click '[data-mobile-target="branch-more"]'
wait_for_js "branch secondary menu" "Boolean(document.querySelector('[data-mobile-branch-menu] [data-mobile-target=branch-note]'))"
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-mobile-branch-menu] [data-mobile-target="branch-note"]');
  if (!el) throw new Error('branch note missing from secondary menu');
  const r = el.getBoundingClientRect();
  if (r.width < 44 || r.height < 44) throw new Error(`branch note: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
  return { width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
})()
JS
ab click '[data-mobile-target="branch-more"]'
wait_for_js "branch secondary menu closed" "!document.querySelector('[data-mobile-branch-menu]')"
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-mobile-target="branch-open"]');
  if (!el) throw new Error('branch open button missing');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return 'expanded';
})()
JS
wait_for_js "branch footer" "Boolean(document.querySelector('[data-mobile-target=branch-submit]'))"
echo "== mobile 390x844: BranchPopover footer =="
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['branch attach', '[data-mobile-target="branch-attach"]'],
    ['branch cancel', '[data-mobile-target="branch-cancel"]'],
    ['branch submit', '[data-mobile-target="branch-submit"]'],
  ];
  const results = specs.map(([name, selector]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  });
  return JSON.stringify(results, null, 2);
})()
JS
ab screenshot "$OUT/mobile-branch-expanded.png" >/dev/null
ab press Escape
wait_for_js "branch popover closed" "!document.querySelector('[data-mobile-target=branch-open]')"

echo "== mobile 390x844: overflow -> tree sheet -> new tree modal =="
ab click 'button[aria-label="更多功能"]'
wait_for_js "mobile overflow" "document.querySelector('[data-mobile-overflow-menu]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
ab click '[data-mobile-target="overflow-tree"]'
wait_for_js "mobile tree sheet" "Boolean(document.querySelector('[data-mobile-tree-sheet=open] [data-mobile-target=new-tree-open]'))"
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-mobile-tree-sheet="open"] [data-mobile-target="new-tree-open"]');
  if (!el) throw new Error('new tree entry missing after overflow -> tree');
  const r = el.getBoundingClientRect();
  if (r.width < 44 || r.height < 44) throw new Error(`new tree entry: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
  return { width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
})()
JS
ab click '[data-mobile-target="new-tree-open"]'
wait_for_js "new tree modal" "Boolean(document.querySelector('[data-mobile-target=new-tree-start]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['new tree close', '[data-mobile-target="new-tree-close"]'],
    ['new tree cancel', '[data-mobile-target="new-tree-cancel"]'],
    ['new tree start', '[data-mobile-target="new-tree-start"]'],
  ];
  const results = specs.map(([name, selector]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  });
  return JSON.stringify(results, null, 2);
})()
JS
ab screenshot "$OUT/mobile-new-tree.png" >/dev/null
ab eval 'document.querySelector("[data-mobile-target=new-tree-close]")?.click(); true'
wait_for_js "new tree modal closed" "!document.querySelector('[data-mobile-target=new-tree-start]')"
ab eval 'document.querySelector("[data-mobile-target=tree-sheet-close]")?.click(); true'
wait_for_js "mobile tree sheet closed" "!document.querySelector('[data-mobile-tree-sheet]')"

ab open "$BASE/?session=mv-touch-ask-session&node=mv-touch-ask"
reauth_if_needed
ab wait '[data-mobile-target="ask-option"]'
echo "== mobile 390x844: Ask card =="
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['ask options', '[data-mobile-target="ask-option"]', true],
    ['ask submit', '[data-mobile-target="ask-submit"]', false],
  ];
  const results = [];
  for (const [name, selector, all] of specs) {
    const elements = [...document.querySelectorAll(selector)];
    if (elements.length === 0) throw new Error(`${name}: missing ${selector}`);
    const measured = (all ? elements : elements.slice(0, 1)).map((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} < 44x44`);
      return { width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
    });
    results.push({ name, selector, count: measured.length, minWidth: Math.min(...measured.map((r) => r.width)), minHeight: Math.min(...measured.map((r) => r.height)) });
  }
  return JSON.stringify(results, null, 2);
})()
JS
ab screenshot "$OUT/mobile-ask.png" >/dev/null

ab set viewport 390 480
echo "== mobile keyboard viewport 390x480 =="
ab eval --stdin <<'JS'
JSON.stringify({ width: innerWidth, height: innerHeight, askVisible: Boolean(document.querySelector('[data-mobile-target="ask-submit"]')) })
JS

ab set viewport 1280 800 1
ab open "$BASE/?session=mv-touch-permission-session&node=mv-touch-permission"
reauth_if_needed
wait_for_js "desktop app shell" "Boolean(document.querySelector('header'))"
ab eval --stdin <<'JS'
(() => {
  localStorage.setItem('trellis-view:mv-touch-permission-session', JSON.stringify({
    activeNodeId: 'mv-touch-permission',
    viewMode: 'linear',
  }));
  location.reload();
  return 'desktop fixture ready';
})()
JS
assert_not_login
wait_for_fixture_node
ab scrollintoview '[data-thread-node-id="mv-touch-done"]'
wait_for_js "desktop answer actions visible" "Boolean(document.querySelector('[data-thread-node-id=mv-touch-done] [data-mobile-target=node-branch]'))"

echo "== desktop 1280x800: unchanged baseline =="
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['drawer new session', '[data-mobile-target="drawer-new-session"]', 159, 32],
    ['drawer close', '[data-mobile-target="drawer-close"]', 28, 32],
    ['drawer attach', '[data-mobile-target="drawer-attach"]', 193, 28],
    ['session row', '[data-mobile-target="session-row"]', 201, 26],
    ['session chain row', '[data-mobile-target="session-chain-row"]', 201, 26],
    ['permission allow', '[data-mobile-target="permission-allow"]', 76.39, 34.75],
    ['permission always', '[data-mobile-target="permission-always"]', 128.39, 36.75],
    ['permission deny', '[data-mobile-target="permission-deny"]', 78.39, 36.75],
    ['code copy', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="code-copy"]', 38, 19.88],
    ['mark read toggle', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="node-read-toggle"]', 25, 21],
    ['branch from node', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="node-branch"]', 25, 21],
    ['delete node', '[data-thread-node-id="mv-touch-permission"] [data-mobile-target="node-delete"]', 25, 21],
    ['response regenerate', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-regenerate"]', 85.67, 28.75],
    ['response card image', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-card-image"]', 78.98, 28.75],
    ['response copy full', '[data-thread-node-id="mv-touch-done"] button[aria-label="复制全文"]', 72, 28.75],
    ['new tree entry', '[data-mobile-target="new-tree-open"]', 55.28, 32],
  ];
  const tolerance = 0.25;
  const results = specs.map(([name, selector, expectedWidth, expectedHeight]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - expectedWidth) > tolerance || Math.abs(r.height - expectedHeight) > tolerance) {
      throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} != ${expectedWidth}x${expectedHeight}`);
    }
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2), expected: `${expectedWidth}x${expectedHeight}` };
  });
  return JSON.stringify(results, null, 2);
})()
JS

echo "== desktop 1280x800: BranchPopover unchanged =="
ab eval --stdin <<'JS'
(() => {
  const p = document.querySelector('[data-chat-node-id="mv-touch-done"] p');
  const text = p?.firstChild;
  if (!text) throw new Error('fixture paragraph missing');
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(12, text.textContent.length));
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return range.toString();
})()
JS
wait_for_js "desktop branch selection actions" "Boolean(document.querySelector('[data-mobile-target=branch-open]')) && Boolean(document.querySelector('[data-mobile-target=branch-note]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['branch selection open', '[data-mobile-target="branch-open"]', 128.05, 33.5],
    ['branch save note', '[data-mobile-target="branch-note"]', 63.05, 33.5],
  ];
  const tolerance = 0.25;
  return JSON.stringify(specs.map(([name, selector, expectedWidth, expectedHeight]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - expectedWidth) > tolerance || Math.abs(r.height - expectedHeight) > tolerance) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} != ${expectedWidth}x${expectedHeight}`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2), expected: `${expectedWidth}x${expectedHeight}` };
  }), null, 2);
})()
JS
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-mobile-target="branch-open"]');
  if (!el) throw new Error('branch open button missing');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return 'expanded';
})()
JS
wait_for_js "desktop branch footer" "Boolean(document.querySelector('[data-mobile-target=branch-submit]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['branch attach', '[data-mobile-target="branch-attach"]', 31, 20],
    ['branch cancel', '[data-mobile-target="branch-cancel"]', 40, 20],
    ['branch submit', '[data-mobile-target="branch-submit"]', 44, 20],
  ];
  const tolerance = 0.25;
  return JSON.stringify(specs.map(([name, selector, expectedWidth, expectedHeight]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - expectedWidth) > tolerance || Math.abs(r.height - expectedHeight) > tolerance) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} != ${expectedWidth}x${expectedHeight}`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2), expected: `${expectedWidth}x${expectedHeight}` };
  }), null, 2);
})()
JS
ab press Escape
wait_for_js "desktop branch popover closed" "!document.querySelector('[data-mobile-target=branch-open]')"

ab click '[data-mobile-target="new-tree-open"]'
wait_for_js "desktop new tree modal" "Boolean(document.querySelector('[data-mobile-target=new-tree-start]'))"
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['new tree close', '[data-mobile-target="new-tree-close"]', 24.2, 36],
    ['new tree cancel', '[data-mobile-target="new-tree-cancel"]', 60, 32],
    ['new tree start', '[data-mobile-target="new-tree-start"]', 60, 32],
  ];
  const tolerance = 0.25;
  return JSON.stringify(specs.map(([name, selector, expectedWidth, expectedHeight]) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${name}: missing ${selector}`);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - expectedWidth) > tolerance || Math.abs(r.height - expectedHeight) > tolerance) throw new Error(`${name}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} != ${expectedWidth}x${expectedHeight}`);
    return { name, selector, width: +r.width.toFixed(2), height: +r.height.toFixed(2), expected: `${expectedWidth}x${expectedHeight}` };
  }), null, 2);
})()
JS
ab click '[data-mobile-target="new-tree-close"]'

ab open "$BASE/?session=mv-touch-ask-session&node=mv-touch-ask"
reauth_if_needed
wait_for_js "desktop ask app shell" "Boolean(document.querySelector('header'))"
ab eval --stdin <<'JS'
(() => {
  localStorage.setItem('trellis-view:mv-touch-ask-session', JSON.stringify({
    activeNodeId: 'mv-touch-ask',
    viewMode: 'linear',
  }));
  location.reload();
  return 'desktop ask ready';
})()
JS
ab wait '[data-mobile-target="ask-option"]'
echo "== desktop 1280x800: Ask card unchanged =="
ab eval --stdin <<'JS'
(() => {
  const optionEls = [...document.querySelectorAll('[data-mobile-target="ask-option"]')];
  if (optionEls.length !== 3) throw new Error(`ask options: expected 3, got ${optionEls.length}`);
  const expected = [[922, 40.39], [922, 40.39], [922, 61.14]];
  const tolerance = 0.25;
  const results = optionEls.map((el, index) => {
    const r = el.getBoundingClientRect();
    const [expectedWidth, expectedHeight] = expected[index];
    if (Math.abs(r.width - expectedWidth) > tolerance || Math.abs(r.height - expectedHeight) > tolerance) throw new Error(`ask option ${index + 1}: ${r.width.toFixed(2)}x${r.height.toFixed(2)} != ${expectedWidth}x${expectedHeight}`);
    return { name: `ask option ${index + 1}`, selector: '[data-mobile-target="ask-option"]', width: +r.width.toFixed(2), height: +r.height.toFixed(2), expected: `${expectedWidth}x${expectedHeight}` };
  });
  const submit = document.querySelector('[data-mobile-target="ask-submit"]');
  if (!submit) throw new Error('ask submit missing');
  const sr = submit.getBoundingClientRect();
  if (Math.abs(sr.width - 60) > tolerance || Math.abs(sr.height - 32) > tolerance) throw new Error(`ask submit: ${sr.width.toFixed(2)}x${sr.height.toFixed(2)} != 60x32`);
  results.push({ name: 'ask submit', selector: '[data-mobile-target="ask-submit"]', width: +sr.width.toFixed(2), height: +sr.height.toFixed(2), expected: '60x32' });
  return JSON.stringify(results, null, 2);
})()
JS
ab screenshot "$OUT/desktop-ask.png" >/dev/null

echo "PASS: mobile touch targets >=44x44; desktop baselines unchanged"
