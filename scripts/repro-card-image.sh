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
OUT_DIR="/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-card-image-8404/out"
mkdir -p "$OUT_DIR"

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

# Log in
ab set viewport 1280 900
ab cookies clear
ab open "$BASE/login"
sleep 1
ab eval 'localStorage.clear(); sessionStorage.clear(); "storage cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
sleep 2

test_case() {
  local name="$1"
  local sid="$2"
  local nid="$3"
  echo "========================================="
  echo "Testing $name (session=$sid, node=$nid)"
  echo "========================================="

  ab open "$BASE/?session=$sid&node=$nid"
  sleep 3

  # Scroll to response so useNearViewport mounts buttons
  ab eval "(() => {
    const el = document.querySelector('[data-chat-node-id=\"$nid\"]') || document.querySelector('[data-thread-node-id=\"$nid\"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  })()"
  sleep 2

  # Check if CardImageButton exists
  local btn_found=$(ab eval "Boolean(document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]') || document.querySelector('[data-mobile-target=\"response-card-image\"]'))")
  echo "CardImageButton found: $btn_found"

  # Clear console before clicking
  ab console --clear || true

  # Click card image button
  ab eval "(() => {
    const btn = document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]') || document.querySelector('[data-mobile-target=\"response-card-image\"]');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  })()"

  # Wait for rendering to settle (either preview dialog opens, or button shows error)
  sleep 4

  # Capture console logs
  echo "--- Console output ---"
  ab console > "$OUT_DIR/repro_${name}_console.txt" 2>&1 || true
  cat "$OUT_DIR/repro_${name}_console.txt"
  echo "--- Page errors ---"
  ab errors > "$OUT_DIR/repro_${name}_errors.txt" 2>&1 || true
  cat "$OUT_DIR/repro_${name}_errors.txt"

  # Check button state and modal state
  ab eval "(() => {
    const btn = document.querySelector('[data-chat-node-id=\"$nid\"] [data-mobile-target=\"response-card-image\"]') || document.querySelector('[data-mobile-target=\"response-card-image\"]');
    const modal = document.querySelector('img[alt*=\"卡片图预览\"]');
    return {
      buttonText: btn ? btn.textContent.trim() : null,
      modalOpened: Boolean(modal),
      modalImgSrc: modal ? modal.src.slice(0, 100) : null
    };
  })()"

  # Take screenshot of page
  ab screenshot "$OUT_DIR/repro_${name}.png"
  echo "Screenshot saved to $OUT_DIR/repro_${name}.png"

  # If modal opened, close it
  ab eval "(() => {
    const closeBtn = document.querySelector('button[aria-label=\"关闭\"]') || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '✕');
    if (closeBtn) closeBtn.click();
    return true;
  })()"
  sleep 1
}

# Run 4 test cases
# 1. codeblock
test_case "codeblock" "9df10952-c973-4f4d-a95f-5c7b077bb8b1" "2ea70e51-de6f-4bea-8fa0-c41814976c6a"

# 2. mermaid
test_case "mermaid" "f9c005ed-7217-4941-b617-8b8fbf56bf2d" "2f4e614c-f2d6-4548-9401-05f63da7ebf0"

# 3. math (KaTeX)
test_case "math" "b3333f44-003a-4409-9bd5-5e9b90e922e6" "c21fd5e6-d172-4974-a5ee-8c1c6945c0cd"

# 4. image
test_case "image" "fe6739be-6bbd-414d-9a8b-2c540a14c640" "d819d3e1-0a5a-4f34-a935-280c5e4f4df8"

echo "Reproduction script completed!"
