#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=3488
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-card-image-verify
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
LOG="$H/server.log"
SESSION=ci-repro
AUTH_PASS=card-image-pass
AUTH_TOKEN=card-image-token
OUT_DIR="${FENJUE_TASK_OUT:-/tmp/trellis-verify/card-image}"
mkdir -p "$OUT_DIR"

TRELLIS_REPRO_REF="${TRELLIS_REPRO_REF:-}"
APP_DIR="$ROOT"
if [ -n "$TRELLIS_REPRO_REF" ]; then
  REF_TAG="${TRELLIS_REPRO_TAG:-baseline}"
  TMP_REPO="/tmp/trellis-repro-baseline-${TRELLIS_REPRO_REF//\//_}"
  echo "Using baseline ref: $TRELLIS_REPRO_REF in $TMP_REPO"
  if [ ! -d "$TMP_REPO/.git" ]; then
    rm -rf "$TMP_REPO"
    git clone -s "$ROOT" "$TMP_REPO"
  fi
  (
    cd "$TMP_REPO"
    git fetch origin "$TRELLIS_REPRO_REF" 2>/dev/null || true
    git checkout "$TRELLIS_REPRO_REF"
    bun install
    bun --bun run build
  )
  APP_DIR="$TMP_REPO"
else
  REF_TAG="${TRELLIS_REPRO_TAG:-postfix}"
  echo "Using current branch code at $ROOT"
fi

SERVER_PID=

fail() {
  echo "repro-card-image: $*" >&2
  exit 1
}

ab() {
  AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"
}

close_browser() {
  ab close >/dev/null 2>&1 || true
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
  leftover_pids=$(ps -ax -o pid= -o command= | awk '$0 ~ /bun server[.]ts -p 3488/ { print $1 }')
  if [ -n "$leftover_pids" ]; then
    kill $leftover_pids >/dev/null 2>&1 || true
  fi
  exit "$cleanup_status"
}
trap cleanup 0 1 2 15

# Prepare isolated database
mkdir -p "$H/.trellis"
rm -f "$DB" "$DB-shm" "$DB-wal" "$LOG"
sqlite3 "$SOURCE_DB" ".backup '$DB'"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

# Launch server
(
  cd "$APP_DIR"
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  exec bun --bun run start -- -p "$PORT"
) >"$LOG" 2>&1 &
SERVER_PID=$!

echo "Waiting for Trellis on port $PORT..."
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
echo "Trellis is ready!"

login_if_needed() {
  ab open "$BASE/login"
  sleep 1
  ab eval 'localStorage.clear(); sessionStorage.clear(); "storage cleared"'
  ab fill '#pw' "$AUTH_PASS"
  ab click 'button[type="submit"]'
  sleep 2
}

run_test() {
  local mode="$1" # desktop or mobile
  local name="$2"
  local sid="$3"
  local nid="$4"
  local prefix="${REF_TAG}_${mode}_${name}"

  echo "========================================="
  echo "Testing [$REF_TAG] $prefix (mode=$mode, name=$name)"
  echo "========================================="

  if [ "$mode" = "mobile" ]; then
    ab set device "iPhone 12" || true
    ab set viewport 390 844
  else
    ab set viewport 1280 900
  fi

  ab open "$BASE/?session=$sid&node=$nid"
  sleep 3

  # Scroll target node into view
  ab eval "(() => {
    const el = document.querySelector('[data-chat-node-id=\"$nid\"]') || document.querySelector('[data-thread-node-id=\"$nid\"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  })()"
  sleep 2

  ab console --clear || true

  # Trigger card image button
  if [ "$mode" = "mobile" ]; then
    echo "Triggering on mobile..."
    ab eval "(() => {
      const moreBtn = document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-more\"]')
        || document.querySelector('[data-chat-node-id=\"$nid\"] button[aria-label*=\"更多回答操作\"]')
        || document.querySelector('[data-mobile-target=\"response-more\"]');
      if (moreBtn) moreBtn.click();
      return Boolean(moreBtn);
    })()"
    sleep 1
    ab eval "(() => {
      const cardBtn = document.querySelector('[data-mobile-response-menu] [data-mobile-target=\"response-card-image\"]')
        || document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]')
        || document.querySelector('[data-mobile-target=\"response-card-image\"]');
      if (cardBtn) {
        cardBtn.click();
        return 'mobile button clicked';
      }
      return 'mobile button not found';
    })()"
  else
    echo "Triggering on desktop..."
    ab eval "(() => {
      const btn = document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]')
        || document.querySelector('[data-mobile-target=\"response-card-image\"]');
      if (btn) {
        btn.click();
        return 'desktop button clicked';
      }
      return 'desktop button not found';
    })()"
  fi

  # Wait for rendering to complete or fail
  local state="waiting"
  for i in $(seq 1 10); do
    sleep 1
    state=$(ab eval "(() => {
      const img = document.querySelector('img[alt*=\"卡片图预览\"]');
      if (img && img.src && img.complete && img.naturalWidth > 0) {
        return 'modal_ready';
      }
      const errEl = document.querySelector('[data-safe-area=\"modal-shell\"] .text-warn-ink');
      if (errEl) {
        return 'modal_error: ' + errEl.textContent.trim();
      }
      const btn = document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]')
        || document.querySelector('[data-mobile-target=\"response-card-image\"]');
      if (btn && btn.textContent && btn.textContent.includes('失败')) {
        return 'button_error';
      }
      return 'waiting';
    })()")
    echo "Wait step $i: $state"
    if [ "$state" != "waiting" ]; then
      break
    fi
  done
  sleep 1

  # Capture console logs and page errors
  ab console > "$OUT_DIR/${prefix}_console.txt" 2>&1 || true
  ab errors > "$OUT_DIR/${prefix}_errors.txt" 2>&1 || true
  ab screenshot "$OUT_DIR/${prefix}.png" 2>&1 || true

  # Also write repro_${REF_TAG}_... alias for backward compatibility
  cp "$OUT_DIR/${prefix}_console.txt" "$OUT_DIR/repro_${prefix}_console.txt" 2>/dev/null || true
  cp "$OUT_DIR/${prefix}_errors.txt" "$OUT_DIR/repro_${prefix}_errors.txt" 2>/dev/null || true
  cp "$OUT_DIR/${prefix}.png" "$OUT_DIR/repro_${prefix}.png" 2>/dev/null || true

  echo "Result: state=$state"
  echo "Console log saved: $OUT_DIR/${prefix}_console.txt ($(wc -c < "$OUT_DIR/${prefix}_console.txt" | tr -d ' ') bytes)"
  echo "Errors log saved:  $OUT_DIR/${prefix}_errors.txt ($(wc -c < "$OUT_DIR/${prefix}_errors.txt" | tr -d ' ') bytes)"
  echo "Screenshot saved:  $OUT_DIR/${prefix}.png"

  # Close dialog if opened
  ab eval "(() => {
    const closeBtn = document.querySelector('button[aria-label=\"关闭\"]') || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '✕');
    if (closeBtn) closeBtn.click();
    return true;
  })()"
  sleep 1
}

# Initial login
ab set viewport 1280 900
login_if_needed

# Run Desktop verification for all 4 types
run_test "desktop" "codeblock" "9df10952-c973-4f4d-a95f-5c7b077bb8b1" "2ea70e51-de6f-4bea-8fa0-c41814976c6a"
run_test "desktop" "mermaid" "f9c005ed-7217-4941-b617-8b8fbf56bf2d" "2f4e614c-f2d6-4548-9401-05f63da7ebf0"
run_test "desktop" "math" "b3333f44-003a-4409-9bd5-5e9b90e922e6" "c21fd5e6-d172-4974-a5ee-8c1c6945c0cd"
run_test "desktop" "image" "fe6739be-6bbd-414d-9a8b-2c540a14c640" "d819d3e1-0a5a-4f34-a935-280c5e4f4df8"

# Run Mobile verification for all 4 types
run_test "mobile" "codeblock" "9df10952-c973-4f4d-a95f-5c7b077bb8b1" "2ea70e51-de6f-4bea-8fa0-c41814976c6a"
run_test "mobile" "mermaid" "f9c005ed-7217-4941-b617-8b8fbf56bf2d" "2f4e614c-f2d6-4548-9401-05f63da7ebf0"
run_test "mobile" "math" "b3333f44-003a-4409-9bd5-5e9b90e922e6" "c21fd5e6-d172-4974-a5ee-8c1c6945c0cd"
run_test "mobile" "image" "fe6739be-6bbd-414d-9a8b-2c540a14c640" "d819d3e1-0a5a-4f34-a935-280c5e4f4df8"

echo "Reproduction run for [$REF_TAG] completed successfully!"
