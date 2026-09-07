#!/bin/sh
set -eu

SOURCE_HOME=${TRELLIS_VERIFY_SOURCE_HOME:-/Users/smokingmouse}
PATH="$SOURCE_HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
for node_bin in "$SOURCE_HOME"/.nvm/versions/node/*/bin; do
  [ -d "$node_bin" ] && PATH="$node_bin:$PATH"
done
export HOME="$SOURCE_HOME" PATH

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3480
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-herdr
DB="$H/.trellis/data.db"
LOG="$H/server.log"
FAKE_LOG="$H/fake-herdr.log"
FAKE_STDOUT="$H/fake-herdr.stdout"
SOCKET="$H/herdr.sock"
OUT="$H/out"
SESSION=mv-mobile-herdr-$$
AUTH_PASS=mv-mobile-herdr-pass
AUTH_TOKEN=mv-mobile-herdr-token
CLAUDE_SESSION=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
SERVER_PID=
FAKE_PID=
LOCK_DIR=/tmp/trellis-mobile-verify.lock

fail() {
  echo "mobile-herdr: $*" >&2
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

stop_pid() {
  owned_pid=$1
  if [ -n "$owned_pid" ] && kill -0 "$owned_pid" >/dev/null 2>&1; then
    kill "$owned_pid" >/dev/null 2>&1 || true
    wait "$owned_pid" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  cleanup_status=$?
  trap - 0 1 2 15
  close_browser
  stop_pid "$FAKE_PID"
  stop_pid "$SERVER_PID"

  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3480/ { print $1 }')
  if [ -n "$leftover_pids" ]; then
    kill $leftover_pids >/dev/null 2>&1 || true
  fi
  cleanup_wait=0
  while curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; do
    cleanup_wait=$((cleanup_wait + 1))
    if [ "$cleanup_wait" -ge 10 ]; then
      echo "WARN: port $PORT still responds after cleanup" >&2
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

lock_wait=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_wait=$((lock_wait + 1))
  if [ "$lock_wait" -ge 180 ]; then
    fail "lock wait timeout (held by $(cat "$LOCK_DIR/owner" 2>/dev/null))"
  fi
  sleep 5
done
echo "$$ $(date +%H:%M:%S) $(basename "$0")" > "$LOCK_DIR/owner"

print_page_diagnostics() {
  ab eval --stdin <<'JS' || true
(() => ({
  href: location.href,
  body: (document.body?.innerText || document.body?.textContent || '').slice(0, 900),
}))()
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

wait_for_log() {
  wait_label=$1
  wait_pattern=$2
  wait_try=0
  while :; do
    if grep -F "$wait_pattern" "$FAKE_LOG" >/dev/null 2>&1; then
      echo "✓ $wait_label"
      return 0
    fi
    wait_try=$((wait_try + 1))
    if [ "$wait_try" -ge 30 ]; then
      tail -n 80 "$FAKE_LOG" >&2 || true
      fail "timed out waiting for $wait_label"
    fi
    sleep 1
  done
}

for required_tool in bun agent-browser sqlite3 curl grep find ps awk sed lsof; do
  command -v "$required_tool" >/dev/null 2>&1 || fail "missing required tool: $required_tool"
done

close_browser
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use"
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
rm -f "$DB" "$DB-shm" "$DB-wal" "$LOG" "$FAKE_LOG" "$FAKE_STDOUT" "$SOCKET"

(
  export HOME="$H"
  export FAKE_HERDR_HOME="$H"
  export FAKE_HERDR_LOG="$FAKE_LOG"
  export FAKE_HERDR_WAIT_DELAY_MS=12000
  export HERDR_SOCKET_PATH="$SOCKET"
  exec bun scripts/mobile-verify/fake-herdr.ts
) >"$FAKE_STDOUT" 2>&1 &
FAKE_PID=$!

fake_ready=0
while [ ! -S "$SOCKET" ]; do
  if ! kill -0 "$FAKE_PID" >/dev/null 2>&1; then
    cat "$FAKE_STDOUT" >&2
    fail "fake Herdr exited during startup"
  fi
  fake_ready=$((fake_ready + 1))
  [ "$fake_ready" -lt 30 ] || fail "fake Herdr socket did not appear"
  sleep 1
done

(
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  export HERDR_SOCKET_PATH="$SOCKET"
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

session_try=0
while [ "$(sqlite3 "$DB" "SELECT count(*) FROM sessions WHERE origin='herdr';" 2>/dev/null || echo 0)" -lt 2 ]; do
  session_try=$((session_try + 1))
  if [ "$session_try" -ge 30 ]; then
    tail -n 120 "$LOG" >&2
    fail "Herdr transcripts were not mirrored"
  fi
  sleep 1
done

endpoint_try=0
if [ "$(sqlite3 "$DB" "SELECT count(*) FROM sessions WHERE origin='herdr' AND kind<>'herdr';")" -ne 0 ]; then
  fail 'Herdr mirrors leaked into the user session kind'
fi
while [ ! -f "$H/.trellis/hooks/endpoint.env" ]; do
  endpoint_try=$((endpoint_try + 1))
  [ "$endpoint_try" -lt 30 ] || fail "hook endpoint.env did not appear"
  sleep 1
done
HOOK_TOKEN=$(sed -n 's/^TRELLIS_HOOK_TOKEN=//p' "$H/.trellis/hooks/endpoint.env")
[ -n "$HOOK_TOKEN" ] || fail "hook token missing"

curl --noproxy '*' -fsS "$BASE/api/hooks/claude" \
  -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tool_name":"AskUserQuestion","tool_input":{"questions":[{"header":"发布策略","question":"请选择交付方案","options":[{"label":"快速方案","description":"优先速度"},{"label":"稳妥方案","description":"优先验证"}]}]}}' \
  >/dev/null

echo "== authenticate isolated desktop session =="
ab set viewport 1280 800
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); true' >/dev/null
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"

echo "== desktop Herdr fleet and interaction =="
wait_for_js "three Herdr pane rows" "document.querySelectorAll('[data-herdr-pane]').length === 3"
wait_for_js "waiting row is first" "document.querySelector('[data-herdr-pane]')?.getAttribute('data-herdr-status') === 'waiting'"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const group = document.querySelector('[data-herdr-group]');
  const rows = [...group.querySelectorAll('[data-herdr-pane]')];
  assert(group.innerText.includes('Herdr'), 'Herdr heading missing');
  const repo = group.querySelector('[data-herdr-repo]');
  assert(group.querySelectorAll('[data-herdr-repo]').length === 1, 'repository grouping missing');
  const worktrees = [...repo.querySelectorAll('[data-herdr-worktree]')];
  assert(worktrees.length === 2, 'two checkouts must share a repository');
  assert(worktrees.every(w => w.querySelectorAll('[data-herdr-pane]').length === 1), 'one pane per checkout');
  assert(worktrees[0].querySelector('[data-sidebar-group]').innerText.includes('main'), 'main branch missing');
  assert(worktrees[1].querySelector('[data-sidebar-group]').innerText.includes('feat/mobile'), 'linked branch missing');
  assert(worktrees[0].querySelector('button').title.includes('Fake Workspace'), 'Herdr label missing from title');
  assert(!repo.querySelector(':scope > [data-sidebar-group]').innerText.includes('待处理'), 'P2-2 expanded repository must hide attention');
  assert(worktrees.every(w => !w.querySelector('[data-sidebar-group]').innerText.includes('待处理')), 'P2-2 expanded worktrees must hide attention');
  const scratch = group.querySelector('[data-herdr-workspace="workspace-scratch"]');
  assert(scratch && !scratch.closest('[data-herdr-repo]') && repo.nextElementSibling === scratch, 'non-git workspace must be flat at the end');
  assert(rows.length === 3, `pane rows=${rows.length}`);
  assert(rows[0].dataset.herdrPane === 'pane-claude', `first pane=${rows[0].dataset.herdrPane}`);
  assert(rows[0].dataset.herdrStatus === 'waiting', `first status=${rows[0].dataset.herdrStatus}`);
  assert(rows[1].dataset.herdrStatus === 'blocked', `second status=${rows[1].dataset.herdrStatus}`);
  assert(group.querySelector('[data-herdr-card-kind="terminal"]'), 'Codex blocked terminal card missing');
  assert(group.querySelector('[data-herdr-screen]')?.innerText.includes('fake terminal line'), 'Codex screen tail missing');
  return rows.map((row) => ({ pane: row.dataset.herdrPane, status: row.dataset.herdrStatus }));
})()
JS
ab screenshot "$OUT/desktop-herdr-sidebar.png"
# P1-1: clear the waiting hook, then reverse urgency while retaining tree positions.
curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tool_name":"Bash","tool_input":{"command":"true"}}' >/dev/null
ab eval --stdin <<'JS'
(async () => {
  window.herdrTreeOrder = [...document.querySelectorAll('[data-herdr-repo], [data-herdr-worktree], [data-herdr-pane]')].map(e => e.dataset.herdrRepo || e.dataset.herdrWorktree || e.dataset.herdrPane);
  await fetch('/api/herdr/panes/pane-claude/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['F8'] }) });
  return true;
})()
JS
wait_for_js "P1-1 reversed urgency keeps main checkout first" "document.querySelector('[data-herdr-pane]')?.dataset.herdrPane === 'pane-claude' && document.querySelector('[data-herdr-pane]')?.dataset.herdrStatus === 'blocked' && document.querySelector('[data-herdr-pane=\"pane-codex\"]')?.dataset.herdrStatus === 'waiting' && JSON.stringify(window.herdrTreeOrder) === JSON.stringify([...document.querySelectorAll('[data-herdr-repo], [data-herdr-worktree], [data-herdr-pane]')].map(e => e.dataset.herdrRepo || e.dataset.herdrWorktree || e.dataset.herdrPane))"
ab eval --stdin <<'JS'
(async () => {
  await fetch('/api/herdr/panes/pane-claude/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['F9'] }) });
  window.newWorkspaceStarted = performance.now();
  await fetch('/api/herdr/panes/pane-claude/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['F10'] }) });
  return true;
})()
JS
wait_for_js "P1-2 event-created workspace is nested immediately" "Boolean(document.querySelector('[data-herdr-repo] [data-herdr-worktree] [data-herdr-pane=\"pane-new\"]'))"
ab eval --stdin <<'JS'
(async () => {
  if (performance.now() - window.newWorkspaceStarted >= 10000) throw new Error('P1-2 new workspace waited for snapshot');
  const wt = document.querySelector('[data-herdr-pane="pane-new"]').closest('[data-herdr-worktree]');
  if (wt.dataset.herdrWorktree.endsWith('/')) throw new Error('P2-3 trailing checkout slash survived');
  if (!wt.querySelector('[data-sidebar-group]').innerText.includes('未知分支')) throw new Error('P2-1 missing checkout claimed a branch');
  await fetch('/api/herdr/panes/pane-claude/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['F11'] }) });
  return true;
})()
JS
wait_for_js "P1-2 closed workspace leaves no empty checkout" "document.querySelectorAll('[data-herdr-worktree]').length === 2 && !document.querySelector('[data-herdr-pane=\"pane-new\"]')"
curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tool_name":"AskUserQuestion","tool_input":{"questions":[{"header":"发布策略","question":"请选择交付方案","options":[{"label":"快速方案","description":"优先速度"},{"label":"稳妥方案","description":"优先验证"}]}]}}' >/dev/null
wait_for_js "waiting hook restored" "document.querySelector('[data-herdr-pane]')?.dataset.herdrStatus === 'waiting'"
ab click '[data-herdr-repo] > [data-sidebar-group] > button'
wait_for_js "collapsed repository retains attention" "document.querySelector('[data-herdr-repo]')?.innerText.includes('2 待处理') && !document.querySelector('[data-herdr-worktree]')"
ab screenshot "$OUT/desktop-herdr-collapsed.png"
ab reload
wait_for_js "repository collapse survives reload" "Boolean(document.querySelector('[data-herdr-repo] button[aria-expanded=false]')) && !document.querySelector('[data-herdr-worktree]')"
ab click '[data-herdr-repo] > [data-sidebar-group] > button'
wait_for_js "repository expands" "document.querySelectorAll('[data-herdr-worktree]').length === 2"
ab click '[data-herdr-worktree]:first-child > [data-sidebar-group] > button'
wait_for_js "worktree collapse retains attention" "!document.querySelector('[data-herdr-pane=\"pane-claude\"]') && document.querySelector('[data-herdr-worktree]')?.innerText.includes('1 待处理')"
ab click '[data-herdr-worktree]:first-child > [data-sidebar-group] > button'
ab click '[data-herdr-pane="pane-claude"]'
wait_for_js "Herdr session badge" "Boolean(document.querySelector('[data-herdr-badge]'))"
wait_for_js "AskUserQuestion card" "document.querySelector('[data-herdr-question]')?.textContent?.includes('请选择交付方案') === true"
ab screenshot "$OUT/desktop-herdr-session.png"
ab click '[data-herdr-option="2"]'
wait_for_log "single option submits without extra Enter" '"keys":["2"]'
wait_for_js "answered card state" "Boolean(document.querySelector('[data-herdr-card-state=answered]'))"

curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tool_name":"AskUserQuestion","tool_use_id":"multi-proof","tool_input":{"questions":[{"question":"选择多个验收项","multiSelect":true,"options":[{"label":"Alpha"},{"label":"Beta"},{"label":"Gamma"}]}]}}' >/dev/null
wait_for_js "multi-select card" "document.querySelector('[data-thread-scroll] [data-herdr-question]')?.textContent?.includes('选择多个验收项') === true"
ab click '[data-thread-scroll] [data-herdr-option="1"]'
wait_for_js "first option toggled without submitting" "document.querySelector('[data-thread-scroll] [data-herdr-option=\"1\"]')?.getAttribute('aria-pressed') === 'true'"
ab click '[data-thread-scroll] [data-herdr-option="3"]'
wait_for_js "two options remain selected" "document.querySelectorAll('[data-thread-scroll] [data-herdr-option][aria-pressed=true]').length === 2"
ab click '[data-thread-scroll] [data-herdr-multi-next]'
wait_for_log "multi-select opens review tab" '"keys":["right"]'
wait_for_js "explicit answer submission" "Boolean(document.querySelector('[data-thread-scroll] [data-herdr-submit-answers]'))"
ab click '[data-thread-scroll] [data-herdr-submit-answers]'
wait_for_js "multi-select submitted" "Boolean(document.querySelector('[data-thread-scroll] [data-herdr-card-state=answered]'))"

curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","agent_id":"parent","tool_name":"AskUserQuestion","tool_use_id":"two-questions","tool_input":{"questions":[{"header":"Color","question":"Color: Red or Blue?","multiSelect":false,"options":[{"label":"Red"},{"label":"Blue"}]},{"header":"Shape","question":"Shape: Circle or Square?","multiSelect":false,"options":[{"label":"Circle"},{"label":"Square"}]}]}}' >/dev/null
wait_for_js "two-question first page" "document.querySelector('[data-thread-scroll] [data-herdr-question]')?.textContent?.includes('Color:') === true"
ab eval "window.multiQuestionKeys = []; const originalKeysFetch = window.fetch; window.fetch = (...args) => { if (String(args[0]).endsWith('/keys')) window.multiQuestionKeys.push(JSON.parse(args[1].body).keys); return originalKeysFetch(...args); }; true"
ab click '[data-thread-scroll] [data-herdr-option="2"]'
wait_for_js "two-question second page" "document.querySelector('[data-thread-scroll] [data-herdr-question]')?.textContent?.includes('Shape:') === true"
ab click '[data-thread-scroll] [data-herdr-option="1"]'
wait_for_js "last digit opens Submit without submitting" "Boolean(document.querySelector('[data-thread-scroll] [data-herdr-submit-answers]')) && JSON.stringify(window.multiQuestionKeys) === '[[\"2\"],[\"1\"]]'"
ab click '[data-thread-scroll] [data-herdr-submit-answers]'
wait_for_js "two-question explicit Enter submits once" "Boolean(document.querySelector('[data-thread-scroll] [data-herdr-card-state=answered]')) && JSON.stringify(window.multiQuestionKeys) === '[[\"2\"],[\"1\"],[\"Enter\"]]'"

for decision in allow deny; do
  curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
    --data-urlencode "payload={\"hook_event_name\":\"PermissionRequest\",\"session_id\":\"$CLAUDE_SESSION\",\"tool_name\":\"Bash\",\"tool_use_id\":\"permission-$decision\",\"summary\":\"permission-$decision\"}" >/dev/null
  wait_for_js "permission $decision" "document.querySelector('[data-thread-scroll] [data-herdr-card-kind=permission]')?.textContent?.includes('permission-$decision') === true"
  ab click "[data-thread-scroll] [data-mobile-target=herdr-permission-$decision]"
  wait_for_js "permission $decision sent" "Boolean(document.querySelector('[data-thread-scroll] [data-herdr-card-state=answered]'))"
done
wait_for_log "permission allow digit only" '"keys":["1"]'
wait_for_log "permission deny Escape" '"keys":["Escape"]'

curl --noproxy '*' -fsS "$BASE/api/hooks/claude" -H "x-trellis-hook-token: $HOOK_TOKEN" \
  --data-urlencode 'payload={"hook_event_name":"PreToolUse","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tool_name":"AskUserQuestion","tool_use_id":"mobile-question","tool_input":{"questions":[{"question":"请选择交付方案","options":[{"label":"快速方案"},{"label":"稳妥方案"}]}]}}' >/dev/null
wait_for_js "question restored for mobile inspection" "document.querySelector('[data-thread-scroll] [data-herdr-question]')?.textContent?.includes('请选择交付方案') === true"

ab fill 'textarea[data-herdr-input]' 'mobile-herdr-input-proof'
ab eval --stdin <<'JS'
(() => {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const started = performance.now();
    const response = await original(...args);
    if (String(args[0]).endsWith('/pane-claude/input')) {
      window.herdrInputProof = { status: response.status, elapsed: performance.now() - started, result: (await response.clone().json()).result };
    }
    return response;
  };
  return true;
})()
JS
ab click '[data-herdr-send]'
wait_for_log "input with Enter" '"text":"mobile-herdr-input-proof","keys":["Enter"]'
wait_for_js "Herdr delivery acknowledgement" "document.querySelector('[data-herdr-delivery]')?.getAttribute('data-herdr-delivery') === 'delivered'"
ab eval --stdin <<'JS'
(() => {
  const proof = window.herdrInputProof;
  if (proof?.status !== 200 || proof.elapsed >= 3000) throw new Error(`send waited for agent: ${JSON.stringify(proof)}`);
  return proof;
})()
JS
if grep -F '"completed":"agent.wait"' "$FAKE_LOG" >/dev/null 2>&1; then
  fail 'agent.wait completed before immediate acknowledgement assertion'
fi
wait_for_js "event-driven Codex idle status" "document.querySelector('[data-herdr-pane=\"pane-codex\"]')?.dataset.herdrStatus === 'idle'"
wait_for_log "subscription initial replay" '"replay":3'
wait_for_log "pane_updated events" '"event":"pane_updated"'

ab eval --stdin <<'JS'
(() => {
  const OriginalEventSource = window.EventSource;
  window.herdrDeliveryEvents = [];
  window.EventSource = class extends OriginalEventSource {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes('/api/herdr/events')) {
        this.addEventListener('message', event => window.herdrDeliveryEvents.push(JSON.parse(event.data)));
      }
    }
  };
  return true;
})()
JS
ab fill 'textarea[data-herdr-input]' 'mobile-herdr-busy-proof'
ab click '[data-herdr-send]'
wait_for_js "busy input immediately queued" "document.querySelector('[data-herdr-delivery]')?.getAttribute('data-herdr-delivery') === 'queued'"
ab eval --stdin <<'JS'
(() => {
  const proof = window.herdrInputProof;
  if (proof?.status !== 202 || proof.elapsed >= 1500) throw new Error(`busy input did not acknowledge queue: ${JSON.stringify(proof)}`);
  if (!document.querySelector('[data-herdr-delivery]')?.textContent.includes('已排队')) throw new Error('queued label missing');
  if (document.querySelector('[data-herdr-input]')?.value !== 'mobile-herdr-busy-proof') throw new Error('queued input text was cleared');
  return proof;
})()
JS
wait_for_log "background queue delivers busy input" '"text":"mobile-herdr-busy-proof","keys":["Enter"]'
wait_for_js "queued input becomes delivered by event" "document.querySelector('[data-herdr-delivery]')?.getAttribute('data-herdr-delivery') === 'delivered'"
wait_for_js "delivered input clears composer" "document.querySelector('[data-herdr-input]')?.value === ''"
wait_for_js "delivery received through SSE" "window.herdrDeliveryEvents.some(fleet => fleet.inputDeliveries.some(input => input.inputId === window.herdrInputProof.result.inputId && input.status === 'delivered'))"

echo "== failed first input does not poison second queued input =="
wait_for_js "previous queue drained" "(async () => (await (await fetch('/api/herdr/fleet')).json()).workspaces.flatMap(w => w.tabs.flatMap(t => t.panes)).find(p => p.pane_id === 'pane-claude')?.agent_status === 'idle')()"
ab eval --stdin <<'JS'
(async () => {
  const response = await fetch('/api/herdr/panes/pane-claude/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['F12'] }),
  });
  if (!response.ok) throw new Error('could not arm fake wait failure');
  return true;
})()
JS
wait_for_js "fake pane busy for failure case" "(async () => (await (await fetch('/api/herdr/fleet')).json()).workspaces.flatMap(w => w.tabs.flatMap(t => t.panes)).find(p => p.pane_id === 'pane-claude')?.agent_status === 'working')()"
ab fill 'textarea[data-herdr-input]' 'mobile-herdr-first-fails'
ab click '[data-herdr-send]'
wait_for_js "first failing input retains queued text" "document.querySelector('[data-herdr-delivery]')?.dataset.herdrDelivery === 'queued' && document.querySelector('[data-herdr-input]')?.value === 'mobile-herdr-first-fails'"
ab eval --stdin <<'JS'
(async () => {
  window.firstFailedInput = window.herdrInputProof.result.inputId;
  if (window.herdrInputProof.status !== 202) throw new Error('first input was not queued');
  const response = await fetch('/api/herdr/panes/pane-claude/input', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'mobile-herdr-second-delivers' }),
  });
  const { result } = await response.json();
  if (response.status !== 202 || result.status !== 'queued') throw new Error('second input was not queued');
  window.secondDeliveredInput = result.inputId;
  return { first: window.firstFailedInput, second: window.secondDeliveredInput };
})()
JS
# Simulate editing the retained draft; failure must restore the submitted text.
ab fill 'textarea[data-herdr-input]' ''
wait_for_js "failed input restores text and shows retry prompt" "document.querySelector('[data-herdr-delivery]')?.dataset.herdrDelivery === 'error' && document.querySelector('[data-herdr-delivery]')?.textContent.includes('发送失败') && document.querySelector('[data-herdr-input]')?.value === 'mobile-herdr-first-fails'"
wait_for_log "second input delivered after first failure" '"text":"mobile-herdr-second-delivers","keys":["Enter"]'
wait_for_js "failure and success receipts stay independent" "window.herdrDeliveryEvents.some(fleet => fleet.inputDeliveries.some(input => input.inputId === window.firstFailedInput && input.status === 'failed' && input.error === 'first wait failed') && fleet.inputDeliveries.some(input => input.inputId === window.secondDeliveredInput && input.status === 'delivered' && !input.error))"
if grep -F '"text":"mobile-herdr-first-fails","keys":["Enter"]' "$FAKE_LOG" >/dev/null 2>&1; then
  fail 'first input was sent despite its failed wait'
fi

echo "== iPhone drawer, header, cards and touch targets =="
ab set device "iPhone 15"
ab set viewport 390 844
ab open "$BASE/?session=$CLAUDE_SESSION"
wait_for_js "iPhone Herdr badge" "Boolean(document.querySelector('[data-herdr-badge]'))"
wait_for_js "iPhone AskUserQuestion card" "Boolean(document.querySelector('[data-herdr-question]'))"
ab click 'button[aria-label="会话列表"]'
wait_for_js "iPhone Herdr drawer" "Boolean(document.querySelector('[role=dialog] [data-herdr-group]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const group = document.querySelector('[role=dialog] [data-herdr-group]');
  const drawer = group?.closest('[role=dialog]');
  assert(drawer, 'mobile Herdr drawer missing');
  const rows = [...group.querySelectorAll('[data-herdr-pane]')];
  assert(rows.length === 3, `mobile rows=${rows.length}`);
  const repo = group.querySelector('[data-herdr-repo]');
  assert(repo?.querySelectorAll('[data-herdr-worktree]').length === 2, 'mobile nested worktrees missing');
  assert(!group.querySelector('[data-herdr-workspace="workspace-scratch"]').closest('[data-herdr-repo]'), 'mobile scratch must be flat');
  assert(!repo.querySelector(':scope > [data-sidebar-group]').innerText.includes('待处理'), 'P2-2 mobile expanded repository must hide attention');
  assert(!repo.querySelector('[data-herdr-worktree] > [data-sidebar-group]').innerText.includes('待处理'), 'P2-2 mobile expanded worktree must hide attention');
  for (const button of group.querySelectorAll('[data-sidebar-group] > button')) {
    assert(button.getBoundingClientRect().height >= 44, 'group touch target under 44px');
  }
  assert(rows[0].dataset.herdrStatus === 'waiting', `mobile first=${rows[0].dataset.herdrStatus}`);
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    assert(rect.height >= 44, `pane touch height=${rect.height}`);
    assert(rect.left >= 0 && rect.right <= innerWidth, `pane overflow=${JSON.stringify(rect.toJSON())}`);
  }
  const targets = [...drawer.querySelectorAll('[data-herdr-card] button')];
  assert(targets.length > 0, 'mobile card controls missing');
  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    assert(rect.width >= 44 && rect.height >= 44, `card touch target=${rect.width}x${rect.height}`);
  }
  return { rows: rows.length, cardTargets: targets.length, viewport: [innerWidth, innerHeight] };
})()
JS
ab screenshot "$OUT/iphone-herdr-drawer.png"
ab click '[role=dialog] [data-herdr-worktree]:first-child > [data-sidebar-group] > button'
wait_for_js "P2-2 mobile collapsed worktree shows attention" "!document.querySelector('[role=dialog] [data-herdr-pane=\"pane-claude\"]') && document.querySelector('[role=dialog] [data-herdr-worktree] > [data-sidebar-group]')?.innerText.includes('1 待处理')"
ab click '[role=dialog] [data-herdr-repo] > [data-sidebar-group] > button'
wait_for_js "P2-2 mobile collapsed repository shows attention" "!document.querySelector('[role=dialog] [data-herdr-worktree]') && document.querySelector('[role=dialog] [data-herdr-repo] > [data-sidebar-group]')?.innerText.includes('1 待处理')"
ab click '[role=dialog] [data-herdr-repo] > [data-sidebar-group] > button'
wait_for_js "P2-2 mobile expanding repository hides only its badge" "!document.querySelector('[role=dialog] [data-herdr-repo] > [data-sidebar-group]')?.innerText.includes('待处理') && document.querySelector('[role=dialog] [data-herdr-worktree] > [data-sidebar-group]')?.innerText.includes('1 待处理')"
ab click '[role=dialog] [data-herdr-worktree]:first-child > [data-sidebar-group] > button'
wait_for_js "P2-2 mobile expanding worktree hides its badge" "Boolean(document.querySelector('[role=dialog] [data-herdr-pane=\"pane-claude\"]')) && !document.querySelector('[role=dialog] [data-herdr-worktree] > [data-sidebar-group]')?.innerText.includes('待处理')"
ab click '[role="dialog"] [data-herdr-pane="pane-claude"]'
wait_for_js "drawer closes into Herdr session" "!document.querySelector('[role=dialog] [data-herdr-group]') && Boolean(document.querySelector('[data-herdr-badge]'))"
ab eval --stdin <<'JS'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const badge = document.querySelector('[data-herdr-badge]');
  const card = document.querySelector('[data-thread-scroll] [data-herdr-card]');
  const input = document.querySelector('[data-herdr-input]');
  const send = document.querySelector('[data-herdr-send]');
  assert(badge && card && input && send, 'mobile Herdr session controls missing');
  assert(document.documentElement.scrollWidth === innerWidth, `page overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
  for (const element of [input, send, ...card.querySelectorAll('button')]) {
    const rect = element.getBoundingClientRect();
    assert(rect.height >= 44, `session touch height=${rect.height}`);
    assert(rect.left >= 0 && rect.right <= innerWidth, `session control overflow=${JSON.stringify(rect.toJSON())}`);
  }
  return { badge: badge.innerText, viewport: [innerWidth, innerHeight] };
})()
JS
ab screenshot "$OUT/iphone-herdr-session.png"

echo "== event-driven pane close =="
ab eval --stdin <<'JS'
(async () => {
  const response = await fetch('/api/herdr/panes/pane-codex/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['Escape'] }),
  });
  if (response.status !== 200) throw new Error(`keys HTTP ${response.status}`);
  return true;
})()
JS
wait_for_log "pane_closed event" '"event":"pane_closed"'
ab click 'button[aria-label="会话列表"]'
wait_for_js "closed pane removed by event" "Boolean(document.querySelector('[role=dialog] [data-herdr-group]')) && !document.querySelector('[data-herdr-pane=\"pane-codex\"]')"
ab click '[role="dialog"] [data-herdr-pane="pane-claude"]'
wait_for_js "return after close event" "!document.querySelector('[role=dialog] [data-herdr-group]')"

echo "== fake Herdr down becomes read-only =="
stop_pid "$FAKE_PID"
FAKE_PID=
wait_for_js "offline read-only banner" "Boolean(document.querySelector('[data-herdr-readonly] [data-herdr-reopen]'))"
ab eval --stdin <<'JS'
(() => {
  if (document.querySelector('[data-herdr-input]')) throw new Error('Herdr input remained after pane went down');
  if (document.querySelector('[data-thread-scroll] [data-herdr-card]')) throw new Error('stale interaction card remained after pane went down');
  if (!document.querySelector('[data-herdr-badge]')?.textContent?.includes('offline')) throw new Error('Herdr badge did not switch to offline');
  const button = document.querySelector('[data-herdr-reopen]');
  if (!button?.textContent?.includes('在 Herdr 里重新打开')) throw new Error('reopen copy missing');
  return button.getBoundingClientRect().toJSON();
})()
JS
ab screenshot "$OUT/iphone-herdr-offline.png"

echo "mobile-herdr: PASS"
echo "screenshots: $OUT/desktop-herdr-sidebar.png $OUT/desktop-herdr-session.png $OUT/iphone-herdr-drawer.png $OUT/iphone-herdr-session.png $OUT/iphone-herdr-offline.png"
