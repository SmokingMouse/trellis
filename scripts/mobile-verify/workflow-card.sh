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
#   · 超过 8 个 agent 的阶段分栏，按**实际列数**算仍超 12 行的尾部折进
#     「… 还有 n 个」（桌面多栏可能根本不该折，手机单列必折）
#   · 失败的 Workflow 在有合法阶段明细时仍然看得到 stderr、长 output 展得开
#   · 窄屏断点精确到 560（含）—— 559 / 560 同侧，561 恢复宽屏
#   · 窄屏隐藏模型短名、表头数字换行、触屏可点区域 ≥44px
#
# 截图落 ${WORKFLOW_CARD_OUT:-/tmp/trellis-mv-workflow-card/out}/shots/。
# 端口与锁可用 WORKFLOW_CARD_PORT（默认 3458）/ WORKFLOW_CARD_LOCK
# （默认 /tmp/trellis-mobile-verify.lock）覆盖，供并行 worktree 各占一份。

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# 端口与锁都可覆盖：两个 worktree 并行验收时，谁也别占着对方那一个。默认值
# 不变，所以老的调用方式（直接 sh scripts/mobile-verify/workflow-card.sh）行为
# 一模一样。
PORT="${WORKFLOW_CARD_PORT:-3458}"
LOCK_DIR="${WORKFLOW_CARD_LOCK:-/tmp/trellis-mobile-verify.lock}"
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

SCRIPT_DONE=0

cleanup() {
  cleanup_status=$?
  trap - 0
  # 早退防假绿：没走到末尾的 PASS 标记就一律非零（bash 3.2 下 set -u 报错进 trap 时 $? 可能仍是 0）
  if [ "$cleanup_status" -eq 0 ] && [ "${SCRIPT_DONE:-0}" != "1" ]; then
    echo "FAIL: workflow card 脚本在到达最终 PASS 前退出（假绿拦截）" >&2
    cleanup_status=1
  fi
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
# 12 行预算按**实际**列数算，所以这里不写死「两栏 / 一定会折」：先量出 CSS
# auto-fill 真排了几栏，再判断该不该折 —— 桌面宽到四栏时 30 个 agent 只有 8
# 行，本来就不该折，那才是对的。单列必折那一支由下面的手机段落证。
SCALE_FOLD=$(ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card]');
  const gate2 = card.querySelector('[data-workflow-phase="Gate2"] [data-workflow-agents]');
  if (gate2.getAttribute('data-workflow-agents') !== 'grid') throw new Error('超过 8 个 agent 的阶段该分栏');
  const cssCols = (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length;
  const cols = cssCols(gate2);
  if (cols < 2) throw new Error(`1440 宽下该至少两栏，实际 ${cols}`);
  const order = [...gate2.querySelectorAll('[data-workflow-agent]')].map((li) => li.getAttribute('data-workflow-agent'));
  const sorted = [...order].sort();
  if (JSON.stringify(order) !== JSON.stringify(sorted)) throw new Error('分栏后必须保持 index 顺序');

  const gate3 = card.querySelector('[data-workflow-phase="Gate3"] [data-workflow-agents]');
  const g3css = cssCols(gate3);
  const g3js = Number(gate3.getAttribute('data-workflow-columns'));
  // 这条就是本次修的东西本身：算预算用的列数必须等于浏览器真排出来的列数。
  if (g3css !== g3js) throw new Error(`折叠预算按 ${g3js} 栏算，CSS 实际 ${g3css} 栏`);
  const visible = gate3.querySelectorAll('[data-workflow-agent]').length;
  const more = gate3.querySelector('[data-workflow-more]');
  const foldedN = more ? Number((more.textContent.match(/还有 (\d+)/) ?? [0, 0])[1]) : 0;
  const total = visible + foldedN;
  const rowsIfAll = Math.ceil(total / g3js);
  if (rowsIfAll > 12 && !more) throw new Error(`${total} 个 / ${g3js} 栏 = ${rowsIfAll} 行，超预算却没折`);
  if (rowsIfAll <= 12 && more) throw new Error(`${total} 个 / ${g3js} 栏 = ${rowsIfAll} 行，没超预算却折了`);
  if (more && Math.ceil(visible / g3js) + 1 > 12) throw new Error(`折叠后仍然超 12 行`);
  if (!gate3.querySelector('[data-workflow-agent][data-state="running"]')) throw new Error('running 行不该被折掉');
  console.log(JSON.stringify({ cols, gate2: order.length, g3cols: g3js, g3Total: total, g3Visible: visible }));
  return more ? 'fold' : 'nofold';
})()
JS
)
echo "✓ desktop scale: ${SCALE_FOLD}（按实际列数算的预算）"
if [ "$SCALE_FOLD" = "fold" ]; then
  ab click '[data-workflow-phase="Gate3"] [data-workflow-more]'
  wait_for_js "folded rows expanded" "document.querySelector('[data-workflow-phase=\"Gate3\"] [data-workflow-more]')?.getAttribute('aria-expanded') === 'true'"
  ab eval --stdin <<'JS'
(() => {
  const more = document.querySelector('[data-workflow-phase="Gate3"] [data-workflow-more]');
  if (!more.textContent.includes('收起')) throw new Error('展开后按钮该变成收起');
  more.click();
  return 'collapsed again';
})()
JS
  wait_for_js "folded rows collapsed again" "document.querySelector('[data-workflow-phase=\"Gate3\"] [data-workflow-more]')?.getAttribute('aria-expanded') === 'false'"
  ab click '[data-workflow-phase="Gate3"] [data-workflow-more]'
  wait_for_js "folded rows expanded for shot" "document.querySelector('[data-workflow-phase=\"Gate3\"] [data-workflow-more]')?.getAttribute('aria-expanded') === 'true'"
fi
ab screenshot "$SHOTS/desktop-workflow-scale.png" >/dev/null

# ── 桌面：失败 + 合法明细 + stderr ───────────────────────────────────────
# 专用 view 接管 body 之后，错误输出仍然得有渲染路径 —— 明细画得越漂亮，越该
# 看得到它究竟往 stderr 吐了什么。
echo "== desktop 1440x900: Workflow 失败带 stderr =="
open_node stderr
wait_for_js "stderr workflow card" "document.querySelector('[data-workflow-card]')?.getAttribute('data-workflow-card') === 'failed'"
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="failed"]');
  const head = card.querySelector('[data-workflow-head]');
  if (head.getAttribute('aria-expanded') !== 'true') throw new Error('失败的卡片不该收起');
  if (!card.querySelector('[data-workflow-phase]')) throw new Error('有合法明细就该画阶段树（不该误降级成 RawView）');
  const labels = [...card.querySelectorAll('.uppercase')].map((el) => el.textContent.trim());
  if (!labels.includes('stderr')) throw new Error(`失败的 Workflow 必须有 stderr 块: ${labels.join(',')}`);
  const text = card.textContent;
  if (!text.includes('WORKFLOW_STDERR_SENTINEL')) throw new Error('stderr 正文不可见');
  if (!text.includes('[review-changes] step 001')) throw new Error('output 该照常显示');
  const expand = [...card.querySelectorAll('button')].find((b) => /展开剩余 \d+ 行/.test(b.textContent));
  if (!expand) throw new Error('205 行的 output 该留一个展开到末行的按钮');
  if (text.includes('WORKFLOW_OUTPUT_LAST_LINE')) throw new Error('长 output 默认该只铺前 200 行');
  expand.click();
  return JSON.stringify({ labels, expand: expand.textContent.trim() });
})()
JS
wait_for_js "output expanded to last line" "document.querySelector('[data-workflow-card=\"failed\"]').textContent.includes('WORKFLOW_OUTPUT_LAST_LINE')"
echo "✓ 长 output 可展开到末行，stderr 与阶段树同屏"
# 截图要看得见 stderr 本身，不是「它在页面某处」—— 滚到它跟前再拍。
ab eval --stdin <<'JS'
(() => {
  const card = document.querySelector('[data-workflow-card="failed"]');
  const label = [...card.querySelectorAll('.uppercase')].find((el) => el.textContent.trim() === 'stderr');
  if (!label) throw new Error('stderr 块不见了');
  label.parentElement.scrollIntoView({ block: 'center' });
  return 'stderr in view';
})()
JS
ab screenshot "$SHOTS/desktop-workflow-failed-stderr.png" >/dev/null

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

# ── 断点：≤560px 含边界 ─────────────────────────────────────────────────
# 参考稿写的是「≤560px」。Tailwind 的 max-[560px] 编出来是 width < 560px，正好
# 把 560 这一点漏在宽屏那侧，所以这里逐点量 559 / 560 / 561：前两点必须同侧
# （隐藏模型短名 + 表头数字换行），561 才恢复宽屏。
echo "== breakpoint 559 / 560 / 561 =="
open_node running
go_live running
wait_for_js "breakpoint card" "Boolean(document.querySelector('[data-workflow-card=\"running\"] [data-workflow-model]'))"

# ── 浅色对比：要读的数值提到 ink-muted ───────────────────────────────────
# 断言比对的是**解析后的 token 值**，不是写死的 rgb —— 换主题也不会误报。
echo "== 浅色对比：表头数值与模型短名提到 ink-muted =="
ab eval --stdin <<'JS'
(() => {
  const root = document.documentElement;
  root.dataset.mvTheme = `${root.classList.contains('dark')}|${root.getAttribute('data-theme') ?? ''}`;
  root.classList.remove('dark');
  root.removeAttribute('data-theme');
  const resolve = (v) => {
    const p = document.createElement('span');
    p.style.color = `var(${v})`;
    root.appendChild(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  };
  const muted = resolve('--ink-muted');
  const faint = resolve('--ink-faint');
  if (muted === faint) throw new Error('浅色下 ink-muted 与 ink-faint 解析成了同一个值');
  const card = document.querySelector('[data-workflow-card="running"]');
  const meta = card.querySelector('[data-workflow-meta]');
  const model = card.querySelector('[data-workflow-model]');
  const metaC = getComputedStyle(meta).color;
  const modelC = getComputedStyle(model).color;
  if (metaC !== muted) throw new Error(`表头数值是 ${metaC}，期望 ink-muted ${muted}（faint=${faint}）`);
  if (modelC !== muted) throw new Error(`模型短名是 ${modelC}，期望 ink-muted ${muted}`);
  // 排队行与纯装饰保持弱化 —— 提对比度不是把整屏拉平。
  const queued = card.querySelector('[data-workflow-agent][data-state="queued"]');
  if (!queued) throw new Error('fixture 该有排队中的 agent 行');
  const queuedC = getComputedStyle(queued.lastElementChild).color;
  if (queuedC !== faint) throw new Error(`排队行数值区是 ${queuedC}，该保持 ink-faint ${faint}`);
  return JSON.stringify({ muted, faint, meta: metaC, model: modelC, queued: queuedC });
})()
JS
ab screenshot "$SHOTS/desktop-workflow-light-contrast.png" >/dev/null
ab eval --stdin <<'JS'
(() => {
  const root = document.documentElement;
  const [wasDark, theme] = (root.dataset.mvTheme ?? 'true|').split('|');
  if (wasDark === 'true') root.classList.add('dark');
  if (theme) root.setAttribute('data-theme', theme);
  delete root.dataset.mvTheme;
  return 'theme restored';
})()
JS
# 视口宽 ≠ CSS 宽（滚动条要吃掉几像素），先标定差值，再让 clientWidth 精确落
# 在 559 / 560 / 561 —— 不标定的话 560 那一点根本轮不到被测。
ab set viewport 1000 900 1
CHROME_W=$(ab eval "1000 - document.documentElement.clientWidth" 2>/dev/null | tail -n 1 | tr -d '" ')
case "$CHROME_W" in ''|*[!0-9]*) CHROME_W=0 ;; esac
echo "  视口 - CSS 宽 = ${CHROME_W}px"
for want in 559 560 561; do
  ab set viewport $((want + CHROME_W)) 900 1
  bp=$(ab eval --stdin <<'JS'
(() => {
  const w = document.documentElement.clientWidth;
  const card = document.querySelector('[data-workflow-card="running"]');
  const model = card.querySelector('[data-workflow-model]');
  if (!model) throw new Error('模型短名元素缺失');
  const head = card.querySelector('[data-workflow-head]');
  const meta = card.querySelector('[data-workflow-meta]');
  const name = head.querySelector('span:nth-of-type(2)');
  const hidden = getComputedStyle(model).display === 'none';
  const wrapped = meta.getBoundingClientRect().top > name.getBoundingClientRect().top;
  const narrow = w <= 560;
  if (hidden !== narrow) throw new Error(`CSS 宽 ${w}px：模型短名 hidden=${hidden}，期望 ${narrow}`);
  // 宽屏那侧不断言「不换行」—— 表头本来就是 flex-wrap，名字长了照样会折。
  if (narrow && !wrapped) throw new Error(`CSS 宽 ${w}px：表头数字该换到第二行`);
  return `${w}|${hidden}|${wrapped}`;
})()
JS
)
  case "$bp" in
    *"$want|"*) echo "✓ ${want}px → ${bp}（宽|模型隐藏|表头换行）" ;;
    *) echo "FAIL: ${want}px 没量准，实得 $bp"; exit 1 ;;
  esac
done

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

# ── 手机：单列时的 12 行预算 ─────────────────────────────────────────────
# 390 宽下 auto-fill 只排得出一栏，所以同一份 30 个 agent 的阶段在这里是 30
# 行、必须折 —— 桌面四栏时它是 8 行、不该折。写死两栏的老算法在这一屏会原样
# 铺开 30 行，正好是最需要折叠的那一屏。
echo "== mobile 390x844: 单列时折叠回到 12 行预算 =="
open_node scale
go_live scale
wait_for_js "mobile scale card" "Boolean(document.querySelector('[data-workflow-phase=\"Gate3\"] [data-workflow-agents]'))"
ab eval --stdin <<'JS'
(() => {
  const gate3 = document.querySelector('[data-workflow-phase="Gate3"] [data-workflow-agents]');
  const cssCols = getComputedStyle(gate3).gridTemplateColumns.split(' ').length;
  const jsCols = Number(gate3.getAttribute('data-workflow-columns'));
  if (cssCols !== 1) throw new Error(`390 宽下该只有一栏，CSS 实际 ${cssCols}`);
  if (jsCols !== 1) throw new Error(`390 宽下预算该按一栏算，实际 ${jsCols}`);
  const more = gate3.querySelector('[data-workflow-more]');
  if (!more) throw new Error('单列 30 行必须折尾');
  const visible = gate3.querySelectorAll('[data-workflow-agent]').length;
  const rows = visible + 1; // 折叠按钮自己占一行
  if (rows > 12) throw new Error(`折叠后仍然 ${rows} 行`);
  if (rows < 10) throw new Error(`折过头了，只剩 ${rows} 行`);
  if (!gate3.querySelector('[data-workflow-agent][data-state="running"]')) throw new Error('running 行不该被折掉');
  gate3.scrollIntoView({ block: 'center' });
  return JSON.stringify({ cssCols, jsCols, visible, rows, more: more.textContent.trim() });
})()
JS
ab screenshot "$SHOTS/mobile-workflow-scale.png" >/dev/null

SCRIPT_DONE=1
echo "PASS: workflow card — 折叠规则 / 阶段规则 / 元信息面板 / 分栏与折叠 / 窄屏与 44px 全部通过"
echo "shots: $SHOTS"
