"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { overflowX, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import { rubberBand, startsInHorizontalScroller } from "@/lib/gestures";
import {
  DRAWER_SWIPE_THRESHOLD,
  drawerProgress,
  drawerWidth,
  subscribeNavDrag,
} from "@/lib/mobile-nav-drag";

// 手机侧栏抽屉（md:hidden）。原先是「开了才挂载 + 从 -16px 淡入」，左缘右滑跟手的又是一块
// 空白预览板，松手瞬间换成真抽屉 ——「换片」感。现在跟手的就是真面板：
//   - 左缘右滑（MobileEdgeSwipe 经 lib/mobile-nav-drag 发事件）：首帧挂上真内容，translateX
//     跟手指走，遮罩透明度随位移；松手按 >40% 或甩动速度判开 / 关，从当前位置弹簧补间到终点。
//   - 展开后在抽屉 / 遮罩上向左拖：同样跟手，松手判关或弹回。起点在会话行（SwipeableRow，
//     data-row-swipe）或横滚元素里时让给它们 —— 行的左右滑优先。
//   - 按钮打开 / 关闭（Header 汉堡、遮罩点按、选中会话后自动收）走同一套补间。
// 关着时不挂载（DOM 里没有第二份侧栏，也不影响 mobile-verify 的 [role=dialog] 选择器）；
// 收起补间播完才卸载。位移全程直接写 style，不经 React state。
const SETTLE_MS = 320; // ≥ --dur-heavy（280ms），留一点余量再卸载

export function MobileNavDrawer({
  open,
  onOpen,
  onClose,
  children,
}: {
  open: boolean;
  /** 拖拽松手判定为展开时调用（把 store 的 mobileNavOpen 置 true） */
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  // 当前 translateX；null = 还没画过（刚挂载）
  const xRef = useRef<number | null>(null);
  const edgeDragRef = useRef(false);
  const pendingXRef = useRef<number | null>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ open, reduced, onOpen, onClose });
  useEffect(() => {
    latest.current = { open, reduced, onOpen, onClose };
  });

  const widthNow = () =>
    panelRef.current?.offsetWidth || drawerWidth(typeof window === "undefined" ? 390 : window.innerWidth);

  const paint = (x: number, animate: boolean) => {
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    xRef.current = x;
    if (!panel || !scrim) {
      pendingXRef.current = x;
      return;
    }
    const motion = animate && !latest.current.reduced;
    panel.style.transition = motion ? "transform var(--dur-heavy) var(--ease-spring)" : "none";
    scrim.style.transition = motion ? "opacity var(--dur-heavy) var(--ease-out)" : "none";
    panel.style.transform = `translate3d(${x}px, 0, 0)`;
    scrim.style.opacity = String(drawerProgress(x, widthNow()));
  };

  const settle = (to: "open" | "closed") => {
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    paint(to === "open" ? 0 : -widthNow(), true);
    if (to === "closed") {
      unmountTimer.current = setTimeout(
        () => {
          unmountTimer.current = null;
          if (latest.current.open || edgeDragRef.current) return;
          xRef.current = null;
          setMounted(false);
        },
        latest.current.reduced ? 0 : SETTLE_MS,
      );
    }
  };

  // 左缘右滑：MobileEdgeSwipe 只管识别手势，位移经总线送到这里直接画。
  useEffect(
    () =>
      subscribeNavDrag((e) => {
        if (e.type === "start") {
          edgeDragRef.current = true;
          pendingXRef.current = -widthNow();
          setMounted(true);
          return;
        }
        if (!edgeDragRef.current) return;
        if (e.type === "move") {
          paint(e.offset - widthNow(), false);
          return;
        }
        edgeDragRef.current = false;
        if (e.type === "end" && e.open) {
          settle("open");
          latest.current.onOpen();
        } else {
          settle("closed");
        }
      }),
    // paint / settle 只读 ref，订阅一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 挂载 / open 变化：从当前位置补间到终点。刚挂载时先在屏外画一帧（或画上拖拽已走到的位置）。
  // open 一置 true 就记为已挂载（渲染期调整 state，而不是在 effect 里 setState）：
  // 之后 open 回到 false 时靠 mounted 留在 DOM 里播完收起补间。
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    if (!mounted) return;
    if (xRef.current === null || pendingXRef.current !== null) {
      paint(pendingXRef.current ?? -widthNow(), false);
      pendingXRef.current = null;
      // 强制回流：让「屏外」这一帧先落地，下面的补间才有起点
      void panelRef.current?.offsetWidth;
    }
    if (edgeDragRef.current) return;
    settle(open ? "open" : "closed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  useEffect(
    () => () => {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    },
    [],
  );

  // 展开态向左拖拽收起（hooks/useSwipe：只认 touch、锁轴纵向优先，纵向照常滚列表）。
  useSwipe(rootRef, {
    enabled: mounted && open,
    axis: "x",
    canStart: (e, el) => {
      const target = e.target as Element;
      if (target.closest("[data-row-swipe], input, textarea, select, [contenteditable=true]")) return false;
      return !startsInHorizontalScroller(target as HTMLElement, el, overflowX);
    },
    size: () => widthNow(),
    threshold: DRAWER_SWIPE_THRESHOLD,
    onMove: (delta) => {
      // 往右拉（已经全开）给一点阻尼，不让面板离开左缘
      paint(delta < 0 ? Math.max(-widthNow(), delta) : rubberBand(delta, 12), false);
    },
    onEnd: ({ commit }) => {
      if (commit < 0) latest.current.onClose();
      else settle("open");
    },
  });

  if (!open && !mounted) return null;
  return (
    <div
      ref={rootRef}
      data-mobile-nav-drawer={open ? "open" : "closed"}
      className="md:hidden fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="会话列表"
    >
      <div
        ref={scrimRef}
        className="absolute inset-0 bg-scrim/50"
        style={{ opacity: 0 }}
        onClick={() => latest.current.onClose()}
        aria-hidden
      />
      <aside
        ref={panelRef}
        // 刘海 / 状态栏：抽屉贴顶，顶部留出 --safe-top（app/globals.css），否则工具条被压在状态栏下。
        // before: 向左多铺一条同色底 —— 弹簧落位有 ~4% 过冲，面板会短暂离开左缘，不能露出背后页面。
        className="absolute left-0 top-0 bottom-0 flex flex-col w-[82vw] max-w-[320px] pt-(--safe-top) bg-surface-canvas border-r border-line shadow-overlay will-change-transform before:absolute before:inset-y-0 before:right-full before:w-8 before:bg-surface-canvas"
        style={{ transform: "translate3d(-100%, 0, 0)" }}
      >
        {children}
      </aside>
    </div>
  );
}
