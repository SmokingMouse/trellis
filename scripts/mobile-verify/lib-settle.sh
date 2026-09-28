# shellcheck shell=sh
# mobile-verify 共用：等弹层 / 抽屉 / Header 的进场动画播完再点或再量。
#
# W2 起 Drawer / Modal / Popover 是 Radix + data-state 驱动的 CSS 动画
# （.ui-drawer 200ms 上滑、.ui-layer 100ms 缩放、Header 200ms translate）。
# 「aria-hidden=false / 节点已挂载」在动画第一帧就成立，这时 agent-browser
# 按当下坐标点下去会落在还在移动的面板之外（点空或点到 scrim），量出来的
# rect 也是半路的。这里不靠固定 sleep：以「目标 rect 连续两帧不变 + 自身和
# 祖先链上没有在播的有限次动画」为准。
#
# 用法（在定义好 SESSION 之后 source）：
#   . "$ROOT/scripts/mobile-verify/lib-settle.sh"
#   mv_wait_settled '<css selector>'   # 点击前：目标自身停稳
#   mv_wait_idle                       # 量几何前：全页有限次动画播完
#   mv_click '<css selector>' [...]    # = mv_wait_settled + agent-browser click
# 接入的脚本里：ab() 对 `ab click <selector>` 自动先 mv_wait_settled（@ref 跳过）；
# wait_for_js 条件成立后再 `mv_wait_idle soft`，后面紧跟的量测不会量到半路。

mv_js_quote() {
  # 把任意字符串转成 JS 单引号字面量的内容（转义 \ 和 '）
  printf '%s' "$1" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/'/\\\\'/g"
}

mv_settle_expr() {
  mv_settle_q=$(mv_js_quote "$1")
  printf '%s' "(async (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const busy = (node) => node.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const a = el.getBoundingClientRect();
  await frame(); await frame();
  const b = el.getBoundingClientRect();
  if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
  for (let n = el; n; n = n.parentElement) if (busy(n)) return false;
  return true;
})('${mv_settle_q}')"
}

mv_idle_expr='(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const busy = () => document.getAnimations().some((a) => a.playState === "running" && a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  if (busy()) return false;
  await frame(); await frame();
  return !busy();
})()'

mv_wait_settled() {
  mv_settle_sel=$1
  mv_settle_js=$(mv_settle_expr "$mv_settle_sel")
  mv_settle_try=0
  while [ "$mv_settle_try" -lt 100 ]; do
    if AGENT_BROWSER_SESSION="$SESSION" agent-browser eval "$mv_settle_js" 2>/dev/null | grep -q '^true$'; then
      return 0
    fi
    mv_settle_try=$((mv_settle_try + 1))
    sleep 0.2
  done
  # 不在这里判失败：交给后面的 click / 断言按原语义报错。
  echo "WARN: ${mv_settle_sel} did not settle before click" >&2
  return 0
}

# mv_wait_idle        —— 等不到（~20s）返回 1，给量几何前用
# mv_wait_idle soft   —— 等 ~5s，等不到只 WARN 不失败，给 wait_for_js 收尾用
mv_wait_idle() {
  mv_idle_max=100
  [ "${1:-}" = soft ] && mv_idle_max=25
  mv_idle_try=0
  while [ "$mv_idle_try" -lt "$mv_idle_max" ]; do
    if AGENT_BROWSER_SESSION="$SESSION" agent-browser eval "$mv_idle_expr" 2>/dev/null | grep -q '^true$'; then
      return 0
    fi
    mv_idle_try=$((mv_idle_try + 1))
    sleep 0.2
  done
  if [ "${1:-}" = soft ]; then
    echo "WARN: animations still running after wait; continuing" >&2
    return 0
  fi
  echo "FAIL: animations still running after 20s" >&2
  return 1
}

mv_click() {
  mv_wait_settled "$1"
  AGENT_BROWSER_SESSION="$SESSION" agent-browser click "$@"
}
