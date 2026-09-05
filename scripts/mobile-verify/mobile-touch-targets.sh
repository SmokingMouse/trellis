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
SERVER_PID=

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already in use"
  exit 1
fi

cleanup() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser close >/dev/null 2>&1 || true
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  pids=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

ab() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"
}

echo "== build =="
bun --bun run build

mkdir -p "$H/.trellis" "$OUT"
rm -f "$DB" "$DB-shm" "$DB-wal"
sqlite3 "$SOURCE_DB" ".backup $DB"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

HOME="$H" TRELLIS_DB_PATH="$DB" TRELLIS_LARK=off \
  bun --bun run start -- -p "$PORT" >"$H/server.log" 2>&1 &
SERVER_PID=$!

i=0
until curl --noproxy '*' -fsS "$BASE/__gate/health" | grep -q '"next":"ready"'; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "FAIL: isolated Trellis exited during startup"
    tail -80 "$H/server.log"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "FAIL: isolated Trellis did not become ready"
    tail -80 "$H/server.log"
    exit 1
  fi
  sleep 0.25
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

ab close >/dev/null 2>&1 || true
ab set device "iPhone 15"
ab set viewport 390 844
ab open "$BASE/?session=mv-touch-permission-session&node=mv-touch-permission"
ab wait 500
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
ab wait '[data-thread-node-id="mv-touch-done"]'

echo "== mobile 390x844: session drawer =="
ab click 'button[aria-label="会话列表"]'
ab wait 100
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['drawer new session', '[role="dialog"] [data-mobile-target="drawer-new-session"]'],
    ['drawer close', '[role="dialog"] [data-mobile-target="drawer-close"]'],
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
ab wait 100

ab scrollintoview '[data-thread-node-id="mv-touch-done"]'
ab wait 400
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
    ['response regenerate', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-regenerate"]'],
    ['response card image', '[data-thread-node-id="mv-touch-done"] [data-mobile-target="response-card-image"]'],
    ['response copy full', '[data-thread-node-id="mv-touch-done"] button[aria-label="复制全文"]'],
    ['new tree entry', '[data-mobile-target="new-tree-open"]'],
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
ab wait 100
ab eval --stdin <<'JS'
(() => {
  const specs = [
    ['branch selection open', '[data-mobile-target="branch-open"]'],
    ['branch save note', '[data-mobile-target="branch-note"]'],
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
ab eval --stdin <<'JS'
(() => {
  const el = document.querySelector('[data-mobile-target="branch-open"]');
  if (!el) throw new Error('branch open button missing');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return 'expanded';
})()
JS
ab wait 100
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
ab wait 100

echo "== mobile 390x844: new tree modal =="
ab click '[data-mobile-target="new-tree-open"]'
ab wait 100
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
ab click '[data-mobile-target="new-tree-close"]'

ab open "$BASE/?session=mv-touch-ask-session&node=mv-touch-ask"
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
ab wait 400
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
ab wait '[data-thread-node-id="mv-touch-done"]'
ab scrollintoview '[data-thread-node-id="mv-touch-done"]'
ab wait 400

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
ab wait 100
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
ab wait 100
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
ab wait 100

ab click '[data-mobile-target="new-tree-open"]'
ab wait 100
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
ab wait 400
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
