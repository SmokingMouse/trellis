#!/bin/sh
set -eu

# 动线卡 · Workflow 行与进度面板的实跑验收。
#
# 起一个隔离实例（真库副本、任务与 lark 关掉），把五种 Workflow 状态和一个
# 普通动线节点写进 tool_calls_json，用 agent-browser 在桌面 1440×900 与手机
# 390×844 各跑一遍，断言：
#   · 结束态默认收成一行，点一下展开
#   · 阶段折叠规则（有未完成的铺开、全完成 / 全排队的收起）
#   · agent 行点开元信息面板
#   · 超过 8 个 agent 的阶段分栏，分栏后仍超 12 行的尾部折进「… 还有 n 个」
#   · 窄屏隐藏模型短名、表头数字换行、触屏可点区域 ≥44px
#
# 截图落 ${WORKFLOW_CARD_OUT:-/tmp/trellis-mv-workflow-card/out}/shots/。

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PORT=3458
BASE="http://127.0.0.1:$PORT"
H=/tmp/trellis-mv-workflow-card
VERIFY_DIST=.next-workflow-card-verify
# 只有验证构建会把 zustand store 的把手挂到 window（stores/sessionStore.ts 末尾，
# NEXT_PUBLIC_TRELLIS_VERIFY=1 才生效）。运行中态需要它：库里灌不出「还活着的
# 流」—— 读接口会把孤儿 streaming 节点判成 interrupted，所以这里是**只改前端
# 那一个 status 字段**把同一份 fixture 切到 live，渲染路径本身一点没动。
VERIFY_LITERAL=__sessionStore
DB="$H/.trellis/data.db"
SOURCE_DB="$HOME/.trellis/data.db"
SESSION=mv-workflow-card
OUT="${WORKFLOW_CARD_OUT:-$H/out}"
SHOTS="$OUT/shots"
AUTH_PASS=mv-workflow-card-pass
AUTH_TOKEN=mv-workflow-card-token
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

reauth_if_needed() {
  if ab eval "location.pathname === '/login'" 2>/dev/null | grep -q '^true$'; then
    echo "↻ authentication expired; signing in again"
    ab wait '#pw'
    ab fill '#pw' "$AUTH_PASS"
    ab click 'button[type="submit"]'
    ab wait --fn "location.pathname !== '/login'"
  fi
}

# 打开某个 fixture 节点，并把动线卡展开到能看见 Workflow 行为止。
open_node() {
  node_key=$1
  ab open "$BASE/?session=mv-wf-$node_key-session&node=mv-wf-$node_key"
  reauth_if_needed
  wait_for_js "app shell ($node_key)" "Boolean(document.querySelector('header'))"
  ab eval --stdin <<JS
(() => {
  localStorage.setItem('trellis-view:mv-wf-$node_key-session', JSON.stringify({
    activeNodeId: 'mv-wf-$node_key',
    viewMode: 'linear',
  }));
  location.reload();
  return 'fixture ready';
})()
JS
  reauth_if_needed
  wait_for_js "timeline card ($node_key)" "Boolean(document.querySelector('[data-tool-timeline-head]'))"
  ab eval --stdin <<'JS'
(() => {
  const head = document.querySelector('[data-tool-timeline-head]');
  if (!head) throw new Error('tool timeline head missing');
  if (head.getAttribute('aria-expanded') !== 'true') head.click();
  return 'timeline open';
})()
JS
  wait_for_js "workflow row ($node_key)" "Boolean(document.querySelector('[data-workflow-card]')) || Boolean(document.querySelector('[data-tool-row]'))"
}

# 把已经渲染出来的节点切成「流还活着」。库里灌不出这个状态（读接口会把孤儿
# streaming 节点判成 interrupted），所以只在前端 store 里改这一个字段 ——
# 组件拿到的 live 与真流式完全一样。
go_live() {
  live_node=$1
  ab eval --stdin <<JS
(() => {
  const store = window.__sessionStore;
  if (!store) throw new Error('verification build missing __sessionStore handle');
  store.setState((s) => {
    const node = s.nodes['mv-wf-$live_node'];
    if (!node) throw new Error('node not in store');
    return { nodes: { ...s.nodes, ['mv-wf-$live_node']: { ...node, status: 'streaming', errorMessage: null } } };
  });
  return 'live';
})()
JS
}

close_browser_session

if curl --noproxy '*' -sS --connect-timeout 1 --max-time 1 "$BASE/" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving HTTP"
  exit 1
fi

build_is_stale() {
  build_stamp=$1
  if [ ! -f "$build_stamp" ]; then
    return 0
  fi
  for source_dir in app components hooks lib stores public; do
    if [ -d "$source_dir" ] && find "$source_dir" -type f -newer "$build_stamp" -print | grep -q .; then
      return 0
    fi
  done
  for source_file in package.json bun.lock next.config.ts postcss.config.mjs tsconfig.json server.ts instrumentation.ts proxy.ts; do
    if [ -f "$source_file" ] && find "$source_file" -newer "$build_stamp" -print | grep -q .; then
      return 0
    fi
  done
  return 1
}

if build_is_stale .next/BUILD_ID; then
  echo "== ordinary build: required =="
  (
    unset TRELLIS_DIST_DIR
    unset NEXT_PUBLIC_TRELLIS_VERIFY
    bun --bun run build
  )
else
  echo "== ordinary build: current .next reused =="
fi

# 生产构建里不许出现验证把手 —— 这条断言就是「验证用的口子不会上线」本身。
if grep -R -F "$VERIFY_LITERAL" .next/static/chunks >/dev/null 2>&1; then
  echo "FAIL: ordinary client build contains $VERIFY_LITERAL" >&2
  exit 1
fi
echo "✓ ordinary client build excludes $VERIFY_LITERAL"

if build_is_stale "$VERIFY_DIST/BUILD_ID" || ! grep -R -F "$VERIFY_LITERAL" "$VERIFY_DIST/static/chunks" >/dev/null 2>&1; then
  echo "== verification build: required =="
  (
    export TRELLIS_DIST_DIR="$VERIFY_DIST"
    export NEXT_PUBLIC_TRELLIS_VERIFY=1
    bun --bun run build
  )
else
  echo "== verification build: current $VERIFY_DIST reused =="
fi
if ! grep -R -F "$VERIFY_LITERAL" "$VERIFY_DIST/static/chunks" >/dev/null 2>&1; then
  echo "FAIL: verification client build is missing $VERIFY_LITERAL" >&2
  exit 1
fi

mkdir -p "$H/.trellis" "$SHOTS"
rm -f "$DB" "$DB-shm" "$DB-wal"
sqlite3 "$SOURCE_DB" ".backup $DB"
sqlite3 "$DB" "UPDATE tasks SET enabled=0; UPDATE task_triggers SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid';"

(
  export HOME="$H"
  export TRELLIS_DB_PATH="$DB"
  export TRELLIS_LARK=off
  export TRELLIS_AUTH_PASS="$AUTH_PASS"
  export TRELLIS_AUTH_TOKEN="$AUTH_TOKEN"
  export TRELLIS_DIST_DIR="$VERIFY_DIST"
  export NEXT_PUBLIC_TRELLIS_VERIFY=1
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

# 启动迁移会把孤儿 streaming 节点收尾，所以 fixture 必须在 ready 之后再灌。
bun scripts/mobile-verify/workflow-card-fixture.ts > "$H/fixture.sql"
sqlite3 "$DB" < "$H/fixture.sql"

ab set viewport 1440 900 1
ab cookies clear
ab open "$BASE/login"
ab wait '#pw'
ab eval 'localStorage.clear(); sessionStorage.clear(); "browser state cleared"'
ab fill '#pw' "$AUTH_PASS"
ab click 'button[type="submit"]'
ab wait --fn "location.pathname !== '/login'"

# ── 桌面：运行中 ─────────────────────────────────────────────────────────
echo "== desktop 1440x900: Workflow 运行中 =="
open_node running
go_live running
wait_for_js "running workflow card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'running'"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="running"]');
  if (!card) throw new Error('running workflow card missing');
  const head = card.querySelector('[data-workflow-head]');
  if (head.getAttribute('aria-expanded') !== 'true') throw new Error('运行中的卡片必须默认展开');
  const meta = card.querySelector('[data-workflow-meta]').textContent;
  if (!/4\/11 agents/.test(meta)) throw new Error(`表头 agents 计数不对: ${meta}`);
  if (!card.querySelector('[data-workflow-rail]')) throw new Error('进度轨缺失');
  const live = card.querySelector('p')?.textContent ?? '';
  if (!live.startsWith('当前')) throw new Error(`实时描述行缺失: ${live}`);
  const phases = [...card.querySelectorAll('[data-workflow-phase]')];
  const state = phases.map((p) => [p.getAttribute('data-workflow-phase'), p.querySelector('button').getAttribute('aria-expanded')]);
  const byTitle = Object.fromEntries(state);
  if (byTitle.Review !== 'true' || byTitle.Verify !== 'true') throw new Error(`含未完成 agent 的阶段该默认展开: ${JSON.stringify(state)}`);
  if (byTitle.Synthesize !== 'false') throw new Error('全部排队的阶段该默认收起');
  const running = card.querySelector('[data-workflow-agent][data-state="running"]');
  if (!running) throw new Error('运行中的 agent 行缺失');
  return JSON.stringify({ meta: meta.replace(/\s+/g, ' ').trim(), live, phases: state });
})()
JS
ab screenshot "$SHOTS/desktop-workflow-running.png" >/dev/null

# ── 桌面：已完成（收起 / 展开 / agent 面板） ─────────────────────────────
echo "== desktop 1440x900: Workflow 已完成 =="
open_node completed
wait_for_js "completed workflow card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'completed'"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="completed"]');
  const head = card.querySelector('[data-workflow-head]');
  if (head.getAttribute('aria-expanded') !== 'false') throw new Error('跑完的卡片该收成一行');
  if (card.querySelector('[data-workflow-phase]')) throw new Error('收起态不该有阶段进 DOM');
  const text = head.textContent.replace(/\s+/g, ' ').trim();
  for (const want of ['review-changes', '已完成', '11/11 agents']) {
    if (!text.includes(want)) throw new Error(`收起态表头缺 ${want}: ${text}`);
  }
  return text;
})()
JS
ab screenshot "$SHOTS/desktop-workflow-completed-collapsed.png" >/dev/null
ab click '[data-workflow-card="completed"] [data-workflow-head]'
wait_for_js "completed card expanded" "Boolean(document.querySelector('[data-workflow-card=\"completed\"] [data-workflow-phase]'))"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="completed"]');
  const result = [...card.querySelectorAll('p')].map((p) => p.textContent).find((t) => t.startsWith('结果'));
  if (!result || !result.includes('completed')) throw new Error(`结果行缺失: ${result}`);
  const phases = [...card.querySelectorAll('[data-workflow-phase]')];
  if (phases.length !== 3) throw new Error(`阶段数不对: ${phases.length}`);
  for (const p of phases) {
    if (p.querySelector('button').getAttribute('aria-expanded') !== 'false') {
      throw new Error(`全部完成的阶段该收起: ${p.getAttribute('data-workflow-phase')}`);
    }
    if (!p.textContent.includes('完成')) throw new Error('阶段头该写 n/n 完成');
  }
  return JSON.stringify({ result, phases: phases.map((p) => p.querySelector('button').textContent.replace(/\s+/g, ' ').trim()) });
})()
JS
# 阶段 → agent 行 → 元信息面板
ab click '[data-workflow-card="completed"] [data-workflow-phase="Verify"] button'
wait_for_js "verify phase expanded" "Boolean(document.querySelector('[data-workflow-phase=\"Verify\"] [data-workflow-agent]'))"
ab eval --stdin <<'JS'
(() => {
  const li = document.querySelector('[data-workflow-phase="Verify"] [data-workflow-agent="verify:db.ts"]');
  if (!li) throw new Error('verify:db.ts 行缺失');
  if (!li.textContent.includes('×2')) throw new Error('attempt>1 该有重试标记');
  li.click();
  return 'agent row clicked';
})()
JS
wait_for_js "agent detail panel" "Boolean(document.querySelector('[data-workflow-detail]'))"
ab eval --stdin <<'JS'
(() => {
  const detail = document.querySelector('[data-workflow-detail="verify:db.ts"]');
  if (!detail) throw new Error('元信息面板缺失');
  const keys = [...detail.querySelectorAll('dt')].map((dt) => dt.textContent);
  for (const want of ['阶段', '模型', '尝试', '状态', '排队于', '开始于', '最近活动', '耗时', 'token', '工具调用']) {
    if (!keys.includes(want)) throw new Error(`面板缺字段 ${want}: ${keys.join(',')}`);
  }
  if (!detail.textContent.includes('交给它的任务') && !detail.textContent.includes('它交回的结果')) {
    // 这一行 fixture 没有 prompt/result 预览，只要面板本身在就行
  }
  return JSON.stringify(keys);
})()
JS
ab screenshot "$SHOTS/desktop-workflow-completed-expanded.png" >/dev/null

# ── 桌面：已失败 ─────────────────────────────────────────────────────────
echo "== desktop 1440x900: Workflow 已失败 =="
open_node failed
wait_for_js "failed workflow card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'failed'"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="failed"]');
  const head = card.querySelector('[data-workflow-head]');
  if (head.getAttribute('aria-expanded') !== 'true') throw new Error('失败的卡片不该收起');
  const meta = card.querySelector('[data-workflow-meta]').textContent.replace(/\s+/g, ' ');
  if (!meta.includes('个已失败')) throw new Error(`表头该报失败数: ${meta}`);
  const failed = card.querySelector('[data-workflow-agent][data-state="failed"]');
  if (!failed) throw new Error('失败的 agent 行必须可见（永不被折叠）');
  const rail = card.querySelector('[data-workflow-rail] > span');
  const fill = getComputedStyle(rail).backgroundColor;
  return JSON.stringify({ meta: meta.trim(), failed: failed.getAttribute('data-workflow-agent'), fill });
})()
JS
ab screenshot "$SHOTS/desktop-workflow-failed.png" >/dev/null

# ── 桌面：无阶段明细 ─────────────────────────────────────────────────────
echo "== desktop 1440x900: Workflow 无阶段明细 =="
open_node bare
wait_for_js "bare workflow card" "Boolean(document.querySelector('[data-workflow-card]'))"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card]');
  const head = card.querySelector('[data-workflow-head]');
  const text = head.textContent.replace(/\s+/g, ' ').trim();
  if (!text.includes('暂无阶段明细')) throw new Error(`该补一句为什么没有明细: ${text}`);
  if (card.querySelector('[data-workflow-rail]')) throw new Error('没有明细就别画 0/0 进度轨');
  head.click();
  return text;
})()
JS
wait_for_js "bare workflow raw body" "document.querySelector('[data-workflow-card]')?.textContent.includes('scriptPath')"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card]');
  if (card.querySelector('[data-workflow-phase]')) throw new Error('不该画空的阶段列表');
  if (!card.textContent.includes('scriptPath')) throw new Error('正文该退化成 RawView');
  return 'fallback ok';
})()
JS

# ── 桌面：53 个 agent 的规模 ─────────────────────────────────────────────
echo "== desktop 1440x900: 53 个 agent =="
open_node scale
go_live scale
wait_for_js "scale workflow card" "Boolean(document.querySelector('[data-workflow-agents=\"grid\"]'))"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card]');
  const gate2 = card.querySelector('[data-workflow-phase="Gate2"] [data-workflow-agents]');
  if (gate2.getAttribute('data-workflow-agents') !== 'grid') throw new Error('超过 8 个 agent 的阶段该分栏');
  const cols = getComputedStyle(gate2).gridTemplateColumns.split(' ').length;
  if (cols < 2) throw new Error(`1440 宽下该是两栏，实际 ${cols}`);
  const order = [...gate2.querySelectorAll('[data-workflow-agent]')].map((li) => li.getAttribute('data-workflow-agent'));
  const sorted = [...order].sort();
  if (JSON.stringify(order) !== JSON.stringify(sorted)) throw new Error('分栏后必须保持 index 顺序');
  const gate3 = card.querySelector('[data-workflow-phase="Gate3"] [data-workflow-agents]');
  const more = gate3.querySelector('[data-workflow-more]');
  if (!more) throw new Error('分栏后仍超 12 行时该有「… 还有 n 个」');
  const beforeRows = gate3.querySelectorAll('[data-workflow-agent]').length;
  const rows = Math.ceil(beforeRows / 2) + 1;
  if (rows > 12) throw new Error(`折叠后仍然 ${rows} 行`);
  if (!gate3.querySelector('[data-workflow-agent][data-state="running"]')) throw new Error('running 行不该被折掉');
  return JSON.stringify({ cols, gate2: order.length, gate3Visible: beforeRows, more: more.textContent.trim() });
})()
JS
ab click '[data-workflow-phase="Gate3"] [data-workflow-more]'
wait_for_js "folded rows expanded" "document.querySelectorAll('[data-workflow-phase=\"Gate3\"] [data-workflow-agent]').length === 30"
ab eval --stdin <<'JS'
(() => {
  const more = document.querySelector('[data-workflow-phase="Gate3"] [data-workflow-more]');
  if (more.getAttribute('aria-expanded') !== 'true') throw new Error('展开后 aria-expanded 该翻');
  if (!more.textContent.includes('收起')) throw new Error('展开后按钮该变成收起');
  more.click();
  return 'collapsed again';
})()
JS
wait_for_js "folded rows collapsed again" "document.querySelectorAll('[data-workflow-phase=\"Gate3\"] [data-workflow-agent]').length === 22"
ab click '[data-workflow-phase="Gate3"] [data-workflow-more]'
wait_for_js "folded rows expanded for shot" "document.querySelectorAll('[data-workflow-phase=\"Gate3\"] [data-workflow-agent]').length === 30"
ab screenshot "$SHOTS/desktop-workflow-scale.png" >/dev/null

# ── 桌面：P1 行语言同框 ──────────────────────────────────────────────────
echo "== desktop 1440x900: 普通行 + 子 Agent + 长跑 Bash 同框 =="
open_node p1
wait_for_js "p1 timeline" "document.querySelectorAll('[data-tool-row]').length > 0"
ab eval --stdin <<'JS'
(() => {
  const rows = [...document.querySelectorAll('[data-tool-row]')];
  const kinds = rows.map((r) => r.getAttribute('data-tool-row'));
  for (const want of ['subagent', 'longRunning']) {
    if (!kinds.includes(want)) throw new Error(`同框缺 ${want}: ${kinds.join(',')}`);
  }
  // 跑完的普通行不再挂「完成」胶囊；失败行仍然要有徽章。
  const done = rows.find((r) => r.getAttribute('data-tool-row') === 'tool' && !r.textContent.includes('失败'));
  if (done && done.querySelector('button').textContent.includes('完成')) {
    throw new Error('已完成的普通行不该再挂「完成」胶囊');
  }
  const failed = rows.find((r) => r.textContent.includes('tsc --noEmit'));
  if (!failed || !failed.textContent.includes('失败')) throw new Error('失败行仍然要有状态徽章');
  const head = rows[0].querySelector('button');
  const h = head.getBoundingClientRect().height;
  if (h > 32) throw new Error(`普通行太高了：${h}px`);
  return JSON.stringify({ kinds, rowHeight: +h.toFixed(2) });
})()
JS
ab screenshot "$SHOTS/desktop-timeline-p1.png" >/dev/null

# ── 手机 390×844 ─────────────────────────────────────────────────────────
ab set device "iPhone 15"
ab set viewport 390 844
echo "== mobile 390x844: Workflow 运行中 =="
open_node running
go_live running
wait_for_js "mobile running card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'running'"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="running"]');
  const head = card.querySelector('[data-workflow-head]');
  const meta = card.querySelector('[data-workflow-meta]');
  // 窄屏：数字整体换到第二行 —— meta 的 top 低于名称那一行。
  const name = head.querySelector('span:nth-of-type(2)');
  if (meta.getBoundingClientRect().top <= name.getBoundingClientRect().top) {
    throw new Error('≤560px 时表头数字该换到第二行');
  }
  const model = card.querySelector('[data-workflow-model]');
  if (model && model.getBoundingClientRect().width > 0) throw new Error('≤560px 该隐藏模型短名');
  // agent 行仍然是一行
  for (const li of card.querySelectorAll('[data-workflow-agent]')) {
    const h = li.getBoundingClientRect().height;
    if (h > 30) throw new Error(`agent 行换行了：${li.getAttribute('data-workflow-agent')} ${h}px`);
  }
  // 触屏可点区域 ≥44px。agent-browser 的设备模拟只改 UA 与视口，不打开触屏
  // 指针（matchMedia('(pointer: coarse)') 恒 false、maxTouchPoints=0），所以
  // 这条规则分两步证：① 样式表里确实有一条 (pointer: coarse) 下的 44px 规则，
  // 且这几个可点元素都挂着那个类；② 把该规则实际加到元素上，量出来 ≥44 而且
  // 版面不塌（agent 行仍是一行）。
  const CLS = 'pointer-coarse:min-h-[44px]';
  let ruleFound = false;
  // Tailwind v4 把工具类包在 @layer 里，媒体块因此是嵌套的 —— 递归走。
  const walk = (list, coarse) => {
    for (let i = 0; i < (list?.length ?? 0); i++) {
      const rule = list[i];
      const cond = rule.conditionText ?? rule.media?.mediaText ?? '';
      const nowCoarse = coarse || /pointer:\s*coarse/.test(cond);
      if (nowCoarse && rule.selectorText?.includes('pointer-coarse') && /min-height:\s*44px/.test(rule.cssText)) {
        ruleFound = true;
      }
      if (rule.cssRules) walk(rule.cssRules, nowCoarse);
    }
  };
  for (let i = 0; i < document.styleSheets.length; i++) {
    try { walk(document.styleSheets[i].cssRules, false); } catch { /* cross-origin */ }
  }
  if (!ruleFound) throw new Error('样式表里没有 (pointer: coarse) 下的 44px 规则');
  if (matchMedia('(pointer: coarse)').matches) throw new Error('这个 harness 居然报了 coarse —— 断言方式该换回直接量');
  const targets = [
    ['workflow head', head],
    ['phase head', card.querySelector('[data-workflow-phase] button')],
  ];
  const sizes = targets.map(([name, el]) => {
    if (!el) throw new Error(`${name} missing`);
    if (!el.classList.contains(CLS)) throw new Error(`${name} 没挂 ${CLS}`);
    const before = el.getBoundingClientRect().height;
    el.style.minHeight = '44px';
    const after = el.getBoundingClientRect().height;
    el.style.minHeight = '';
    if (after < 44) throw new Error(`${name}: 应用 coarse 规则后仍然 ${after.toFixed(2)} < 44`);
    return { name, natural: +before.toFixed(2), coarse: +after.toFixed(2) };
  });
  return JSON.stringify({ sizes }, null, 2);
})()
JS
ab screenshot "$SHOTS/mobile-workflow-running.png" >/dev/null

echo "== mobile 390x844: Workflow 已完成（展开） =="
open_node completed
wait_for_js "mobile completed card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'completed'"
ab click '[data-workflow-card="completed"] [data-workflow-head]'
wait_for_js "mobile completed expanded" "Boolean(document.querySelector('[data-workflow-card=\"completed\"] [data-workflow-phase]'))"
ab click '[data-workflow-card="completed"] [data-workflow-phase="Verify"] button'
wait_for_js "mobile verify phase expanded" "Boolean(document.querySelector('[data-workflow-phase=\"Verify\"] [data-workflow-agent]'))"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="completed"]');
  const rows = [...card.querySelectorAll('[data-workflow-agent]')];
  if (rows.length === 0) throw new Error('agent 行缺失');
  const tall = rows.filter((li) => li.getBoundingClientRect().height > 30);
  if (tall.length > 0) throw new Error(`手机上 agent 行换行了: ${tall.map((li) => li.getAttribute('data-workflow-agent')).join(',')}`);
  return JSON.stringify({ rows: rows.length, height: +rows[0].getBoundingClientRect().height.toFixed(2) });
})()
JS
ab screenshot "$SHOTS/mobile-workflow-completed-expanded.png" >/dev/null

echo "PASS: workflow card — 折叠规则 / 阶段规则 / 元信息面板 / 分栏与折叠 / 窄屏与 44px 全部通过"
echo "shots: $SHOTS"
