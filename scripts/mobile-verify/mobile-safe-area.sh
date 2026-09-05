#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=3471
BASE="http://127.0.0.1:${PORT}"
H=/tmp/trellis-mv-mobile-safe-area
DB="$H/.trellis/data.db"
LOG="$H/server.log"
OUT="${OUT:-$H/screenshots}"
SESSION=mv-mobile-safe-area
APP_PID=""
OWNS_PORT=0

fail() {
  echo "mobile-safe-area: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  local port_pids=""
  trap - EXIT INT TERM
  set +e
  agent-browser --session "$SESSION" close >/dev/null 2>&1
  if [[ -n "$APP_PID" ]]; then
    kill "$APP_PID" >/dev/null 2>&1
    wait "$APP_PID" >/dev/null 2>&1
  fi
  if [[ "$OWNS_PORT" == 1 ]]; then
    port_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
    if [[ -n "$port_pids" ]]; then
      kill $port_pids >/dev/null 2>&1
    fi
  fi
  exit "$status"
}

trap cleanup EXIT INT TERM
cd "$ROOT_DIR"

command -v bun >/dev/null || fail "bun 不可用"
command -v sqlite3 >/dev/null || fail "sqlite3 不可用"
command -v agent-browser >/dev/null || fail "agent-browser 不可用"
command -v lsof >/dev/null || fail "lsof 不可用"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "端口 $PORT 已被占用"
fi

rg -q 'viewportFit: "cover"' app/layout.tsx || fail "缺少 viewportFit: cover"
rg -q 'themeColor: "#fafaf9"' app/layout.tsx || fail "缺少 theme-color viewport 配置"
rg -q 'userScalable: false' app/layout.tsx || fail "user-scalable 基线被改动"

MANIFEST_THEME="$(bun -e 'console.log(JSON.parse(await Bun.file("public/manifest.json").text()).theme_color)')"
[[ "$MANIFEST_THEME" == "#fafaf9" ]] || fail "layout 与 manifest theme_color 不一致"

SAFE_ENV_FILES="$(rg -l 'env[(]safe-area-inset-' app components --glob '*.{css,ts,tsx}' || true)"
[[ "$SAFE_ENV_FILES" == "app/globals.css" ]] || fail "safe-area env() 必须只定义在 app/globals.css"
SAFE_ENV_COUNT="$(rg -o 'env[(]safe-area-inset-' app/globals.css | wc -l | tr -d ' ')"
[[ "$SAFE_ENV_COUNT" == 4 ]] || fail "四个 safe-area env() 变量未完整定义"

rg -q -- 'var[(]--safe-top[)]' components/Header.tsx || fail "Header 未消费 --safe-top"
rg -q -- 'var[(]--safe-bottom[)]' components/LinearThreadView.tsx || fail "Linear Composer 未消费 --safe-bottom"
rg -q -- 'var[(]--safe-bottom[)]' components/ui/Drawer.tsx || fail "bottom sheet 未消费 --safe-bottom"
rg -q -- 'var[(]--safe-top[)]' components/ui/Modal.tsx || fail "modal 壳未消费 safe-area 变量"

LEGACY_VIEWPORT_PATTERN='100''vh|\b(min-)?h-''screen\b'
if rg -n "$LEGACY_VIEWPORT_PATTERN" app components lib hooks public server.ts tenancy --glob '*.{css,html,json,ts,tsx}'; then
  fail "仍有 legacy viewport height 残留"
fi

if rg -n 'serviceWorker|service-worker|navigator[.]serviceWorker' app components public --glob '*.{css,html,json,js,ts,tsx}'; then
  fail "本改动不得加入 service worker"
fi

bun --bun run build

mkdir -p "$H/.trellis" "$OUT"
sqlite3 ~/.trellis/data.db ".backup $DB"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

SID=36b126d3-83a5-4cd8-9669-2cfdc209747f
NID=6ec8616f-6418-4954-8474-aa94d6c7cf4c
FIXTURE_COUNT="$(sqlite3 "$DB" "SELECT count(*) FROM sessions s JOIN nodes n ON n.session_id=s.id WHERE s.id='$SID' AND n.id='$NID';")"
[[ "$FIXTURE_COUNT" == 1 ]] || fail "桌面基线 fixture 不存在：$SID / $NID"

TRELLIS_AUTH_PASS= TRELLIS_AUTH_TOKEN= HOME="$H" TRELLIS_DB_PATH="$DB" TRELLIS_LARK=off \
  bun --bun run start -- -p "$PORT" >"$LOG" 2>&1 &
APP_PID=$!
OWNS_PORT=1

ready=0
for _ in {1..60}; do
  if curl --noproxy '*' -fsS "$BASE/api/sessions" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    tail -80 "$LOG" >&2
    fail "服务提前退出"
  fi
  sleep 0.25
done
[[ "$ready" == 1 ]] || { tail -80 "$LOG" >&2; fail "服务未就绪"; }

URL="$BASE/?session=$SID&node=$NID"
agent-browser --session "$SESSION" set device "iPhone 15"
agent-browser --session "$SESSION" set viewport 390 844
agent-browser --session "$SESSION" open "$BASE/"
agent-browser --session "$SESSION" storage local clear
agent-browser --session "$SESSION" open "$URL"
agent-browser --session "$SESSION" wait 'textarea[placeholder*="继续对话"]'

agent-browser --session "$SESSION" eval --stdin <<'MOBILE_EOF'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.6) => Math.abs(actual - expected) <= tolerance;
  const root = document.documentElement;
  const viewport = document.querySelector('meta[name="viewport"]')?.content ?? '';
  const themeColors = [...document.querySelectorAll('meta[name="theme-color"]')];

  assert(viewport.includes('viewport-fit=cover'), `viewport meta: ${viewport}`);
  assert(themeColors.length > 0, 'theme-color meta 缺失');
  assert(themeColors.some((meta) => meta.content === '#fafaf9'), 'theme-color 与 manifest 不一致');
  assert(getComputedStyle(root).getPropertyValue('--safe-bottom').trim() !== '', '--safe-bottom 不可读');

  root.style.setProperty('--safe-top', '47px');
  root.style.setProperty('--safe-bottom', '34px');
  root.style.setProperty('--safe-left', '0px');
  root.style.setProperty('--safe-right', '0px');

  const header = document.querySelector('[data-safe-area="header"]');
  const thread = document.querySelector('[data-safe-area="linear-thread"]');
  const composer = document.querySelector('[data-safe-area="linear-composer"]');
  const textarea = composer?.querySelector('textarea');
  assert(header && thread && composer && textarea, 'safe-area 验收节点缺失');

  const headerRect = header.getBoundingClientRect();
  const composerRect = composer.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  assert(near(headerRect.top, 0) && near(headerRect.height, 95), `Header 几何异常: ${headerRect.top}/${headerRect.height}`);
  assert(getComputedStyle(header).paddingTop === '47px', 'Header 未消费 --safe-top');
  assert(getComputedStyle(thread).paddingTop === '95px', 'thread 顶部未避让 Header safe-area');
  assert(getComputedStyle(composer).paddingBottom === '34px', 'Composer 未消费 --safe-bottom');
  assert(composerRect.top >= headerRect.bottom && near(composerRect.bottom, innerHeight), 'Composer 顶底裁切');
  assert(textareaRect.bottom <= innerHeight - 34, 'Composer 控件侵入底部安全区');

  return {
    viewport: { width: innerWidth, height: innerHeight },
    header: { top: headerRect.top, height: headerRect.height },
    composer: { top: composerRect.top, bottom: composerRect.bottom, paddingBottom: getComputedStyle(composer).paddingBottom },
  };
})()
MOBILE_EOF
agent-browser --session "$SESSION" screenshot "$OUT/390x844-safe-area.png"

agent-browser --session "$SESSION" set viewport 390 480
agent-browser --session "$SESSION" fill 'textarea[placeholder*="继续对话"]' 'verify only — do not send'
agent-browser --session "$SESSION" eval --stdin <<'KEYBOARD_EOF'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.6) => Math.abs(actual - expected) <= tolerance;
  const header = document.querySelector('[data-safe-area="header"]');
  const composer = document.querySelector('[data-safe-area="linear-composer"]');
  const textarea = composer?.querySelector('textarea');
  assert(header && composer && textarea, '键盘态验收节点缺失');
  const headerRect = header.getBoundingClientRect();
  const composerRect = composer.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  assert(near(headerRect.top, 0) && headerRect.bottom <= innerHeight, '键盘态 Header 裁切');
  assert(composerRect.top >= headerRect.bottom && near(composerRect.bottom, innerHeight), '键盘态 Composer 裁切');
  assert(textareaRect.bottom <= innerHeight - 34, '键盘态控件侵入底部安全区');
  return { viewport: { width: innerWidth, height: innerHeight }, headerBottom: headerRect.bottom, composer: { top: composerRect.top, bottom: composerRect.bottom } };
})()
KEYBOARD_EOF
agent-browser --session "$SESSION" screenshot "$OUT/390x480-safe-area.png"

agent-browser --session "$SESSION" set viewport 1280 800
agent-browser --session "$SESSION" open "$URL"
agent-browser --session "$SESSION" wait 'textarea[placeholder*="继续对话"]'
agent-browser --session "$SESSION" eval --stdin <<'DESKTOP_EOF'
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.6) => Math.abs(actual - expected) <= tolerance;
  const rootStyle = getComputedStyle(document.documentElement);
  const safe = ['--safe-top', '--safe-bottom', '--safe-left', '--safe-right']
    .map((name) => [name, rootStyle.getPropertyValue(name).trim()]);
  assert(safe.every(([, value]) => value === '0px'), `桌面 safe-area 非零: ${JSON.stringify(safe)}`);

  const header = document.querySelector('[data-safe-area="header"]');
  const composer = document.querySelector('[data-safe-area="linear-composer"]');
  assert(header && composer, '桌面对照节点缺失');
  const hr = header.getBoundingClientRect();
  const cr = composer.getBoundingClientRect();
  assert(near(hr.top, 0) && near(hr.width, 1280) && near(hr.height, 48), `Header 偏离改前基线: ${JSON.stringify({ top: hr.top, width: hr.width, height: hr.height })}`);
  assert(near(cr.left, 210) && near(cr.top, 729) && near(cr.width, 1070) && near(cr.height, 71) && near(cr.bottom, 800), `Composer 偏离改前基线: ${JSON.stringify({ left: cr.left, top: cr.top, width: cr.width, height: cr.height, bottom: cr.bottom })}`);

  const visible = (el) => el.offsetParent !== null;
  const label = (el) => el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().replace(/\s+/g, '').slice(0, 60);
  const headerButtons = [...document.querySelectorAll('header button')].filter(visible);
  const expectedHeader = [
    ['搜索', 30, 22],
    ['上下文占用，点击查看详情', 58.6, 22],
    ['工作区文件', 30, 22],
    ['笔记', 30, 22],
    ['导出当前对话', 49, 24],
    ['[Claude]Opus▾', 127.5, 24],
    ['主题', 28, 28],
  ];
  assert(headerButtons.length === expectedHeader.length, `Header 可见按钮数量变化: ${headerButtons.length}`);
  headerButtons.forEach((button, index) => {
    const rect = button.getBoundingClientRect();
    const [expectedLabel, width, height] = expectedHeader[index];
    assert(label(button) === expectedLabel, `Header 按钮清单变化: ${label(button)} != ${expectedLabel}`);
    assert(near(rect.width, width) && near(rect.height, height), `Header 按钮尺寸变化: ${expectedLabel} ${rect.width}x${rect.height}`);
  });

  const composerButtons = [...composer.querySelectorAll('button')].filter(visible);
  const expectedComposer = ['添加附件', '画个草图', '发送'];
  assert(composerButtons.length === expectedComposer.length, `Composer 可见按钮数量变化: ${composerButtons.length}`);
  composerButtons.forEach((button, index) => {
    const rect = button.getBoundingClientRect();
    assert(label(button) === expectedComposer[index], `Composer 按钮清单变化: ${label(button)}`);
    assert(near(rect.width, 44) && near(rect.height, 44), `Composer 按钮尺寸变化: ${label(button)} ${rect.width}x${rect.height}`);
  });

  return { safe, header: { width: hr.width, height: hr.height }, composer: { left: cr.left, top: cr.top, width: cr.width, height: cr.height }, headerButtons: expectedHeader.map(([name]) => name), composerButtons: expectedComposer };
})()
DESKTOP_EOF
agent-browser --session "$SESSION" screenshot "$OUT/1280x800-desktop.png"

echo "mobile-safe-area verification passed; screenshots: $OUT"
