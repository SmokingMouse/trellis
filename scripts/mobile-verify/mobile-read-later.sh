#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3476
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-mobile-read-later
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
SESSION=mv-read-later
AUTH_PASS=mv-read-later-pass
AUTH_TOKEN=mv-read-later-token
SERVER_PID=
EXPECTED_TITLE=稍后再读验收会话

fail() {
  echo "mobile-read-later: $*" >&2
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
  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3476/ { print $1 }')
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

show_mobile_header() {
  ab eval '(() => { const scroll = document.querySelector("[data-thread-scroll]"); if (scroll) scroll.scrollTop = 0; return true; })()' >/dev/null
  wait_for_js "mobile header visible" "!document.querySelector('[data-mobile-header]')?.hasAttribute('data-header-hidden')"
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

# Work only in the backup. Pick the smallest active user session containing a
# completed response so loading remains quick; never create a model run.
NID=$(sqlite3 "$DB" "SELECT n.id FROM nodes n JOIN sessions s ON s.id=n.session_id WHERE s.archived=0 AND s.kind='user' AND n.status='done' AND length(trim(n.response))>=20 ORDER BY (SELECT count(*) FROM nodes x WHERE x.session_id=n.session_id), n.created_at DESC LIMIT 1;")
[ -n "$NID" ] || fail "database copy has no completed content node"
SID=$(sqlite3 "$DB" "SELECT session_id FROM nodes WHERE id='$NID';")
[ -n "$SID" ] || fail "selected node has no session"
sqlite3 "$DB" "UPDATE nodes SET bookmarked_at=NULL; UPDATE nodes SET read_at=NULL WHERE id='$NID'; UPDATE sessions SET title='$EXPECTED_TITLE' WHERE id='$SID';"
URL="$BASE/?session=$SID&node=$NID"

echo "== authenticate isolated iPhone session =="
ab set device "iPhone 15"
ab set viewport 390 844
ab cookies clear
ab open "$BASE/login"
wait_for_js "login form" "Boolean(document.querySelector('#pw'))"
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
wait_for_js "authenticated home" "location.pathname !== '/login'"
ab open "$URL"
wait_for_js "selected content card" "Boolean(document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-target=\"response-more\"]'))"

echo "== iPhone 15: card bookmark and overflow count =="
ab eval "document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-target=\"response-more\"]')?.click(); true"
wait_for_js "mobile response menu" "Boolean(document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-response-menu]'))"
ab eval "document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-response-menu] [aria-label=\"稍后再读\"]')?.click(); true"
wait_for_js "bookmark saved" "Boolean(document.querySelector('[data-thread-node-id=\"$NID\"] [data-bookmarked=\"true\"]'))"
ab eval "document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-target=\"response-more\"]')?.click(); true"
wait_for_js "mobile cancel bookmark state" "Boolean(document.querySelector('[data-thread-node-id=\"$NID\"] [data-mobile-response-menu] [aria-label=\"取消稍后再读\"]'))"
show_mobile_header
ab click 'button[aria-label="更多功能"]'
wait_for_js "overflow count one" "document.querySelector('[data-mobile-target=\"overflow-bookmarks\"]')?.textContent?.includes('稍后再读 (1)') === true"
ab eval --stdin <<'JS'
(() => {
  const button = document.querySelector('[data-mobile-target="overflow-bookmarks"]');
  const rect = button?.getBoundingClientRect();
  if (!rect || rect.width < 44 || rect.height < 44) throw new Error(`overflow bookmark target=${rect?.width}x${rect?.height}`);
  return { text: button.textContent.trim(), width: rect.width, height: rect.height };
})()
JS
ab click '[data-mobile-target="overflow-bookmarks"]'
wait_for_js "read-later bottom sheet" "document.querySelector('[data-bookmarks-drawer]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'"
wait_for_js "bookmark drawer initial focus" "document.activeElement?.getAttribute('data-mobile-target') === 'bookmarks-close'"
ab eval --stdin <<JS
(() => {
  const row = document.querySelector('[data-bookmarks-drawer] [data-bookmark-node-id="$NID"]');
  const done = row?.querySelector('[data-mobile-target="bookmark-done"]');
  const rr = row?.getBoundingClientRect();
  const dr = done?.getBoundingClientRect();
  if (!row || !rr || rr.height < 44) throw new Error('bookmark row height=' + rr?.height);
  if (!dr || dr.width < 44 || dr.height < 44) throw new Error('bookmark done target=' + dr?.width + 'x' + dr?.height);
  if (!row.textContent.includes('$EXPECTED_TITLE')) throw new Error('missing session title: ' + row.textContent);
  return { text: row.textContent.trim(), rowHeight: rr.height, done: { width: dr.width, height: dr.height } };
})()
JS
ab click "[data-bookmarks-drawer] [data-bookmark-node-id=\"$NID\"] > button:first-child"
wait_for_js "bookmark deep link" "new URL(location.href).searchParams.get('node') === '$NID'"

echo "== iPhone 15: read-done removes bookmark only =="
show_mobile_header
ab click 'button[aria-label="更多功能"]'
wait_for_js "overflow still counts one" "document.querySelector('[data-mobile-target=\"overflow-bookmarks\"]')?.textContent?.includes('(1)') === true"
ab click '[data-mobile-target="overflow-bookmarks"]'
wait_for_js "bookmark row returned" "Boolean(document.querySelector('[data-bookmarks-drawer] [data-bookmark-node-id=\"$NID\"]'))"
READ_BEFORE_DONE=$(sqlite3 "$DB" "SELECT coalesce(read_at,'NULL') FROM nodes WHERE id='$NID';")
ab click "[data-bookmarks-drawer] [data-bookmark-node-id=\"$NID\"] [data-mobile-target=\"bookmark-done\"]"
wait_for_js "read-later sheet count zero" "document.querySelector('[data-bookmarks-drawer] h2')?.textContent?.includes('(0)') === true"
READ_AFTER_DONE=$(sqlite3 "$DB" "SELECT coalesce(read_at,'NULL') FROM nodes WHERE id='$NID';")
[ "$READ_AFTER_DONE" = "$READ_BEFORE_DONE" ] || fail "读完 action changed independent read_at: $READ_BEFORE_DONE -> $READ_AFTER_DONE"
ab click '[data-mobile-target="bookmarks-close"]'
wait_for_js "bookmark drawer returns focus" "document.activeElement?.getAttribute('data-mobile-target') === 'header-overflow'"
show_mobile_header
ab click 'button[aria-label="更多功能"]'
wait_for_js "overflow count zero" "document.querySelector('[data-mobile-target=\"overflow-bookmarks\"]')?.textContent?.includes('(0)') === true"
ab click '[data-mobile-target="overflow-close"]'

echo "== 1280x800: action and sidebar group with baseline preserved =="
ab set viewport 1280 800
ab open "$URL"
wait_for_js "desktop bookmark action" "Boolean([...document.querySelectorAll('[data-thread-node-id=\"$NID\"] [aria-label=\"稍后再读\"]')].find((element) => element.offsetParent !== null))"
if ! ab eval "Boolean([...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0))" | grep -q '^true$'; then
  ab click 'button[aria-label="展开侧栏"]'
fi
wait_for_js "desktop sidebar" "Boolean([...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0))"
ab eval --stdin <<'JS'
(() => {
  const aside = [...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0);
  if (!aside) throw new Error('desktop sidebar missing');
  if (aside.querySelector('[data-read-later-group]')) throw new Error('read-later group visible before desktop bookmark');
  const baseline = aside.querySelectorAll('[data-sidebar-group]').length;
  sessionStorage.setItem('mv-read-later-group-baseline', String(baseline));
  return { baselineGroups: baseline };
})()
JS
ab eval "[...document.querySelectorAll('[data-thread-node-id=\"$NID\"] [aria-label=\"稍后再读\"]')].find((element) => element.offsetParent !== null)?.click(); true"
wait_for_js "desktop read-later group" "Boolean([...document.querySelectorAll('[data-read-later-group]')].find((element) => element.offsetParent !== null))"
ab eval --stdin <<JS
(() => {
  const aside = [...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0);
  const group = aside?.querySelector('[data-read-later-group]');
  const row = group?.querySelector('[data-bookmark-node-id="$NID"]');
  const bookmark = document.querySelector('[data-thread-node-id="$NID"] [aria-label="取消稍后再读"]');
  const baseline = Number(sessionStorage.getItem('mv-read-later-group-baseline'));
  const total = aside?.querySelectorAll('[data-sidebar-group]').length;
  if (!group || !row || !bookmark) throw new Error('desktop bookmark UI incomplete');
  if (!group.textContent.includes('稍后再读 (1)')) throw new Error('group label=' + group.textContent);
  if (!row.textContent.includes('$EXPECTED_TITLE')) throw new Error('row title=' + row.textContent);
  if (total - 1 !== baseline) throw new Error('other groups changed: baseline=' + baseline + ', total=' + total);
  return { baselineGroups: baseline, totalWithBookmark: total, text: row.textContent.trim() };
})()
JS
ab eval "[...document.querySelectorAll('[data-thread-node-id=\"$NID\"] [aria-label=\"取消稍后再读\"]')].find((element) => element.offsetParent !== null)?.click(); true"
wait_for_js "desktop read-later group removed" "![...document.querySelectorAll('[data-read-later-group]')].some((element) => element.offsetParent !== null)"
ab eval --stdin <<'JS'
(() => {
  const aside = [...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0);
  const baseline = Number(sessionStorage.getItem('mv-read-later-group-baseline'));
  const total = aside?.querySelectorAll('[data-sidebar-group]').length;
  if (total !== baseline) throw new Error(`groups after clear=${total}, baseline=${baseline}`);
  return { groupsAfterClear: total };
})()
JS

echo "PASS: card-level read-later bookmark, deep link, mobile sheet, desktop group, and independent read state"
