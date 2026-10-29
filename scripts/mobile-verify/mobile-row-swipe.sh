#!/bin/sh
# 手机侧栏会话行左右滑动验收（components/SwipeableRow.tsx + lib/row-swipe.ts）。
#
# 不自己起服务：先按隔离实例起法把 trellis 起在 BASE（默认 127.0.0.1:3482，cookie trellis_auth=AUTH_TOKEN），
# 本脚本只开一个 iPhone 14 视口的 agent-browser session 去点。会真的归档 / 置顶再撤销，**只对隔离库跑**。
#
# 手势用 eval 派发合成的 PointerEvent（pointerType=touch）+ TouchEvent：hooks/useSwipe 只认 touch 指针，
# agent-browser 的 mouse 在设备模拟下仍是 pointerType=mouse。合成事件不会触发浏览器原生滚动，
# 「纵向滚动不误触发」验的是 useSwipe 锁到 y 轴后放手（行不展开、不执行、不打开会话）。
set -eu

BASE=${BASE:-http://127.0.0.1:3482}
AUTH_TOKEN=${AUTH_TOKEN:-x2token}
SESSION=${SESSION:-mv-row-swipe}

case "${BASE}" in
  *:3088*) echo "mobile-row-swipe: 拒绝对 prod（3088）跑" >&2; exit 1 ;;
esac

ab() { AGENT_BROWSER_SESSION="${SESSION}" agent-browser "$@"; }

fail() {
  echo "mobile-row-swipe: FAIL ${1}" >&2
  ab close >/dev/null 2>&1 || true
  exit 1
}

# 跑一段 JS，输出必须以 "OK" 开头
check() {
  name=$1
  out=$(ab eval --stdin)
  echo "${name}: ${out}"
  case "${out}" in
    \"OK*|OK*) ;;
    *) fail "${name}" ;;
  esac
}

ab set device "iPhone 14" >/dev/null
ab open "${BASE}/login" >/dev/null
ab cookies set trellis_auth "${AUTH_TOKEN}" >/dev/null
ab open "${BASE}/" >/dev/null
ab wait --load networkidle >/dev/null
ab eval 'localStorage.removeItem("trellis:sidebar:include-archived"); true' >/dev/null

# 共用助手：合成触摸滑动 / 点按 / 等待
HELPER=$(cat <<'JS'
window.__rs = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async until(fn, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await this.wait(50); }
    return null;
  },
  drawerOpen: () => !!document.querySelector('[role="dialog"][aria-modal="true"] [data-sidebar-list]'),
  rows: () => [...document.querySelectorAll('[role="dialog"] [data-row-swipe]')],
  rowOf: (el) => el.closest('[data-row-swipe]'),
  idOf: (sw) => sw.querySelector('[data-session-id]').dataset.sessionId,
  async swipe(el, dx, dy, { startX, steps = 8, click = true } = {}) {
    const r = el.getBoundingClientRect();
    const x0 = startX ?? r.left + r.width * 0.55;
    const y0 = r.top + r.height / 2;
    const id = 41;
    const P = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1 });
    const T = (type, x, y) => {
      const t = new Touch({ identifier: id, target: el, clientX: x, clientY: y });
      const live = type === "touchend" ? [] : [t];
      return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: live, targetTouches: live, changedTouches: [t] });
    };
    el.dispatchEvent(P("pointerdown", x0, y0)); el.dispatchEvent(T("touchstart", x0, y0));
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps;
      el.dispatchEvent(P("pointermove", x, y)); el.dispatchEvent(T("touchmove", x, y));
      await this.wait(16);
    }
    await this.wait(120); // 停一下再松手：速度归零，只按距离判
    el.dispatchEvent(P("pointerup", x0 + dx, y0 + dy)); el.dispatchEvent(T("touchend", x0 + dx, y0 + dy));
    // 真浏览器划完不一定补 click；补一个，顺带验 useSwipe 吞掉划完的 click
    if (click) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x0 + dx, clientY: y0 + dy }));
    await this.wait(260);
  },
  async tap(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await this.wait(260);
  },
  async listed(id, archived = false) {
    const d = await (await fetch(archived ? "/api/sessions?archived=1" : "/api/sessions")).json();
    return (d.sessions ?? []).some((s) => s.id === id);
  },
  toastText: () => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent).join(" | "),
};
true;
JS
)

open_drawer() {
  printf '%s\n%s\n' "${HELPER}" '(async () => {
    if (!__rs.drawerOpen()) document.querySelector("header button[aria-label=\"会话列表\"]").click();
    const ok = await __rs.until(() => __rs.drawerOpen() && __rs.rows().length >= 2);
    await __rs.wait(300);
    return ok ? "OK drawer rows=" + __rs.rows().length : "FAIL no drawer/rows";
  })()' | check open_drawer
}

open_drawer

# 1. 左滑半程 → 停在展开态，露出「删除」「归档」，按钮 ≥44px；点行外收回
check left_half_open <<'JS'
(async () => {
  const sw = __rs.rows()[0];
  const activeBefore = location.href;
  await __rs.swipe(sw.querySelector("[data-session-id]"), -100, 4);
  if (sw.dataset.rowSwipe !== "trailing") return "FAIL state=" + sw.dataset.rowSwipe;
  const btns = [...sw.querySelectorAll("[data-row-swipe-action]")].map((b) => { const r = b.getBoundingClientRect(); return b.dataset.rowSwipeAction + ":" + Math.round(r.width) + "x" + Math.round(r.height); });
  const small = [...sw.querySelectorAll("[data-row-swipe-action]")].some((b) => { const r = b.getBoundingClientRect(); return r.width < 44 || r.height < 44; });
  if (small || btns.length !== 2) return "FAIL buttons " + btns.join(",");
  if (!__rs.drawerOpen()) return "FAIL drawer closed by left swipe";
  if (location.href !== activeBefore) return "FAIL navigated";
  // 点行外（列表上方工具条）收回
  const outside = document.querySelector('[role="dialog"] [data-sidebar-toolbar], [role="dialog"] [data-app-mode-switch]');
  outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 43, pointerType: "touch", isPrimary: true }));
  await __rs.wait(260);
  if (sw.dataset.rowSwipe !== "closed") return "FAIL not closed by outside tap: " + sw.dataset.rowSwipe;
  return "OK " + btns.join(",") + " drawerOpen=" + __rs.drawerOpen();
})()
JS

# 2. 同时只允许一行展开：A 左滑展开后，B 右滑展开 → A 收回；点展开着的 B 本身只收回、不打开会话
check single_open <<'JS'
(async () => {
  const [a, b] = __rs.rows();
  await __rs.swipe(a.querySelector("[data-session-id]"), -100, 3);
  if (a.dataset.rowSwipe !== "trailing") return "FAIL a not open";
  await __rs.swipe(b.querySelector("[data-session-id]"), 60, 2);
  if (b.dataset.rowSwipe !== "leading") return "FAIL b state=" + b.dataset.rowSwipe;
  if (a.dataset.rowSwipe !== "closed") return "FAIL a still " + a.dataset.rowSwipe;
  const pin = b.querySelector('[data-row-swipe-action="pin"]').getBoundingClientRect();
  await __rs.tap(b.querySelector("[data-session-id] span.truncate"));
  if (b.dataset.rowSwipe !== "closed") return "FAIL b not closed by tap";
  if (!__rs.drawerOpen()) return "FAIL tap on open row opened session / closed drawer";
  return "OK pinBtn=" + Math.round(pin.width) + "x" + Math.round(pin.height);
})()
JS

# 3. 纵向为主的划动不进入滑动（交给列表滚动）：不展开、不执行、不打开会话、抽屉不关
check vertical_ignored <<'JS'
(async () => {
  const sw = __rs.rows()[1];
  const id = __rs.idOf(sw);
  await __rs.swipe(sw.querySelector("[data-session-id]"), -30, 140, { click: false });
  await __rs.swipe(sw.querySelector("[data-session-id]"), 40, -120, { click: false });
  if (sw.dataset.rowSwipe !== "closed") return "FAIL opened by vertical: " + sw.dataset.rowSwipe;
  if (!__rs.drawerOpen()) return "FAIL drawer closed";
  if (!(await __rs.listed(id))) return "FAIL row archived by vertical";
  return "OK stays closed";
})()
JS

# 4. 左滑到底 → 直接归档，抽屉不关；toast 可撤销，撤销后回到列表
check left_full_archive <<'JS'
(async () => {
  const sw = __rs.rows().find((r) => !r.querySelector("[data-session-archived]"));
  const id = __rs.idOf(sw);
  const w = sw.getBoundingClientRect().width;
  await __rs.swipe(sw.querySelector("[data-session-id]"), -(w - 20), 4);
  if (!__rs.drawerOpen()) return "FAIL drawer closed by full left swipe";
  const archived = await __rs.until(async () => (await __rs.listed(id, true)) && !(await __rs.listed(id)));
  if (!archived) return "FAIL not archived";
  const toastOk = await __rs.until(() => /已归档/.test(__rs.toastText()));
  if (!toastOk) return "FAIL no toast: " + __rs.toastText();
  const undo = [...document.querySelectorAll("[data-sonner-toast] button")].find((b) => b.textContent === "撤销");
  if (!undo) return "FAIL no undo button";
  undo.click();
  const restored = await __rs.until(async () => await __rs.listed(id));
  if (!restored) return "FAIL undo did not unarchive";
  await __rs.until(() => document.querySelector('[role="dialog"] [data-session-id="' + id + '"]'));
  return "OK archived+undone " + id;
})()
JS

# 5. 右滑到底（从抽屉左缘 20px 内起手）→ 置顶，toast 撤销；抽屉不关、不跳进会话
check right_full_pin <<'JS'
(async () => {
  document.querySelectorAll("[data-sonner-toast] button[aria-label]").forEach((b) => b.click());
  const sw = __rs.rows().find((r) => r.querySelector('[data-row-swipe-action="pin"]') === null);
  const id = __rs.idOf(sw);
  const pinnedBefore = !!document.querySelector('[role="dialog"] [data-sidebar-pinned] [data-session-id="' + id + '"]');
  const w = sw.getBoundingClientRect().width;
  await __rs.swipe(sw.querySelector("[data-session-id]"), w - 30, 3, { startX: 12 });
  if (!__rs.drawerOpen()) return "FAIL drawer closed by right swipe";
  const t = await __rs.until(() => /置顶/.test(__rs.toastText()) && __rs.toastText());
  if (!t) return "FAIL no pin toast";
  const undo = [...document.querySelectorAll("[data-sonner-toast] button")].reverse().find((b) => b.textContent === "撤销");
  undo.click();
  await __rs.wait(800);
  const pinnedAfter = !!document.querySelector('[role="dialog"] [data-sidebar-pinned] [data-session-id="' + id + '"]');
  if (pinnedAfter !== pinnedBefore) return "FAIL undo pin mismatch before=" + pinnedBefore + " after=" + pinnedAfter;
  return "OK toast=" + t.slice(0, 40) + " pinnedBefore=" + pinnedBefore;
})()
JS

# 6. 点露出的「删除」→ 走现有二次确认（不直接删）；取消后会话还在
check delete_confirms <<'JS'
(async () => {
  const sw = __rs.rows()[0];
  const id = __rs.idOf(sw);
  await __rs.swipe(sw.querySelector("[data-session-id]"), -100, 2);
  sw.querySelector('[data-row-swipe-action="delete"]').click();
  const dlg = await __rs.until(() => [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].find((d) => /删除会话/.test(d.textContent)));
  if (!dlg) return "FAIL no confirm dialog";
  const cancel = [...dlg.querySelectorAll("button")].find((b) => /取消/.test(b.textContent));
  cancel.click();
  await __rs.wait(400);
  if (!(await __rs.listed(id))) return "FAIL deleted without confirm";
  return "OK confirm shown, cancelled, row closed=" + (sw.dataset.rowSwipe === "closed");
})()
JS

# 7. 减少动态效果：跟手 / 收回都不带 transition
ab set media light reduced-motion >/dev/null
check reduced_motion <<'JS'
(async () => {
  await __rs.wait(200);
  const sw = __rs.rows()[0];
  await __rs.swipe(sw.querySelector("[data-session-id]"), -100, 2);
  const tr = sw.querySelector("[data-row-swipe-track]").style.transition;
  const st = sw.dataset.rowSwipe;
  document.querySelector('[role="dialog"] [data-app-mode-switch]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 44, pointerType: "touch", isPrimary: true }));
  await __rs.wait(100);
  return st === "trailing" && tr === "none" ? "OK transition=none" : "FAIL state=" + st + " transition=" + tr;
})()
JS
ab set media light >/dev/null

# 8. 抽屉关着时左缘右滑仍能拉出抽屉（MobileEdgeSwipe 未受影响）
check edge_swipe_still_opens <<'JS'
(async () => {
  document.querySelector('[role="dialog"] [data-mobile-target="drawer-close"]').click();
  await __rs.until(() => !__rs.drawerOpen());
  const el = document.elementFromPoint(6, 400) || document.body;
  await __rs.swipe(el, 220, 4, { startX: 6, click: false });
  const opened = await __rs.until(() => __rs.drawerOpen(), 1500);
  return opened ? "OK edge swipe opens drawer" : "FAIL edge swipe broken";
})()
JS

ab close >/dev/null 2>&1 || true
echo "mobile-row-swipe: PASS"
