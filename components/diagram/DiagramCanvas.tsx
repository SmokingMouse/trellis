"use client";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, ChevronUp, Map as MapIcon, Minus, Plus, Scan, Search, X } from "lucide-react";
import { Icon, IconButton, Input, cn } from "@/components/ui";
import { svgToDataUrl } from "@/lib/svg";

// 图表查看画布：代码块全屏查看、.mmd / .svg 文件预览共用。
//
// 交互约定（对齐 Figma / Excalidraw 这类画布，触控板优先）：
//   拖拽 · 单指               平移
//   滚轮 · 双指滑动            平移（Shift + 滚轮 = 横向）
//   ⌘/Ctrl + 滚轮 · 捏合       以指针为中心缩放
//   双击 · 双击轻点            放大 2×（Shift / Alt + 双击缩小）
//   键盘 + − 缩放 · 0 适应窗口 · 1 实际大小 · 方向键平移 · / 或 ⌘F 查找
//
// 缩放走 transform（不改布局尺寸），且不设 will-change：浏览器在比例稳定后按新
// 比例重新栅格化，放大不糊；大图也只绘制视口内的部分。
// 内联 SVG（Mermaid 渲染结果）支持按文字查找节点；外部 SVG 走 <img> 隔离，只看不搜。

export type DiagramSource =
  | { kind: "inline"; svg: string; width: number; height: number }
  | { kind: "image"; src: string; width: number; height: number };

// 画布底：grid 给跟随主题出图的 Mermaid；其余三种给透明 SVG 选衬底。
export type DiagramBackground = "grid" | "checkered" | "white" | "dark";
export const DIAGRAM_BACKGROUND_CLASS: Record<DiagramBackground, string> = {
  grid: "diagram-bg-grid",
  checkered: "diagram-bg-checkered",
  white: "bg-white",
  dark: "code-surface",
};

type View = { x: number; y: number; s: number };
type Box = { x: number; y: number; w: number; h: number };

const MAX_SCALE = 8;
const FIT_PAD = 32;
// 「适应窗口」最多放大到 2×：三五个节点的小图别糊满一屏
const FIT_MAX = 2;
// 低于这个比例整图就只剩轮廓（16px 字号缩到 5px 以下），打开时改走「阅读视图」
const READABLE_SCALE = 0.3;
// 平移时至少留这么多像素的图在视口里，拖不丢
const KEEP_VISIBLE = 64;
const ZOOM_STEP = 1.25;
const MINIMAP_W = 200;
const MINIMAP_H = 140;
// 查找命中后高亮到「整个节点」而不只是那行字；没有已知分组就高亮文字本身
const HIT_GROUP = "g.node, g.edgeLabel, g.cluster-label, g.mindmap-node";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// 下界比上界还大（视口比保留边距还窄）时取中点，别让 clamp 来回跳
const clampSpan = (v: number, lo: number, hi: number) => (lo <= hi ? clamp(v, lo, hi) : (lo + hi) / 2);
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function DiagramCanvas({
  source,
  background = "grid",
  autoFocus = false,
  label = "图表",
  className,
}: {
  source: DiagramSource;
  background?: DiagramBackground;
  autoFocus?: boolean;
  /** 读屏名 / <img> alt */
  label?: string;
  className?: string;
}) {
  // 尺寸未知（SVG 没写宽高也没 viewBox）时给个画框兜底，别让缩放 / 缩略图除以 0
  const W = source.width > 0 ? source.width : 800;
  const H = source.height > 0 ? source.height : 600;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, s: 1 });
  const stageSize = useRef({ w: 0, h: 0 });
  // 视图还处在自动布局（初始视图 / 适应窗口）：容器尺寸变了就按同一规则重排；
  // 用户动过（缩放 / 平移）之后改为保持视口中心不动
  const layoutMode = useRef<"initial" | "fit" | null>("initial");
  const uiFrame = useRef(0);
  // 带动画的视图切换（按钮 / 键盘 / 查找跳转）预计结束的时刻
  const animatingUntil = useRef(0);
  const [ui, setUi] = useState<{ view: View; vw: number; vh: number }>({
    view: { x: 0, y: 0, s: 1 },
    vw: 0,
    vh: 0,
  });
  const [dragging, setDragging] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const [coarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  );

  const fitScale = useCallback(() => {
    const { w, h } = stageSize.current;
    if (!w || !h || !W || !H) return 1;
    return Math.max(0.01, Math.min((w - FIT_PAD * 2) / W, (h - FIT_PAD * 2) / H));
  }, [W, H]);

  const clampScale = useCallback(
    (s: number) => clamp(s, Math.min(0.25, fitScale() * 0.5), MAX_SCALE),
    [fitScale],
  );

  // 唯一写视图的地方：直接改 DOM transform（不走 React 渲染），控件读数每帧最多同步一次。
  const apply = useCallback(
    (next: View, animate: boolean) => {
      const { w: vw, h: vh } = stageSize.current;
      const s = next.s;
      const keepX = Math.min(KEEP_VISIBLE, W * s);
      const keepY = Math.min(KEEP_VISIBLE, H * s);
      const x = clampSpan(next.x, keepX - W * s, vw - keepX);
      const y = clampSpan(next.y, keepY - H * s, vh - keepY);
      view.current = { x, y, s };
      const layer = layerRef.current;
      if (layer) {
        layer.style.transition = animate ? "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
        animatingUntil.current = animate ? performance.now() + 240 : 0;
        layer.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
        layer.style.setProperty("--diagram-inv-scale", String(1 / s));
      }
      const stage = stageRef.current;
      if (stage) stage.style.backgroundPosition = `${x}px ${y}px`;
      if (!uiFrame.current) {
        uiFrame.current = requestAnimationFrame(() => {
          uiFrame.current = 0;
          setUi({ view: view.current, vw: stageSize.current.w, vh: stageSize.current.h });
        });
      }
    },
    [W, H],
  );

  // 动画中途被拖拽 / 滚轮 / 捏合打断：view 里存的是动画终点，先同步成图层此刻的真实位置，
  // 否则下一帧会从终点起算，画面瞬移一下
  const settleAnimation = useCallback(() => {
    const layer = layerRef.current;
    if (!layer || performance.now() >= animatingUntil.current) return;
    animatingUntil.current = 0;
    const t = getComputedStyle(layer).transform;
    if (!t || t === "none") return;
    const m = new DOMMatrixReadOnly(t);
    view.current = { x: m.e, y: m.f, s: m.a };
    layer.style.transition = "none";
    layer.style.transform = `translate(${m.e}px, ${m.f}px) scale(${m.a})`;
  }, []);

  const fit = useCallback(
    (animate: boolean) => {
      const { w: vw, h: vh } = stageSize.current;
      if (!vw || !vh || !W || !H) return;
      const s = Math.min(fitScale(), FIT_MAX);
      layoutMode.current = "fit";
      apply({ s, x: (vw - W * s) / 2, y: (vh - H * s) / 2 }, animate);
    },
    [W, H, fitScale, apply],
  );

  // 打开时的视图：整图放得下且字还认得出 → 适应窗口；否则（超宽 / 超长图，尤其手机
  // 竖屏，整图塞进来只剩百分之几）改成「短边撑满、从长边的开头读起」，配合缩略图定位。
  const initialView = useCallback(() => {
    const { w: vw, h: vh } = stageSize.current;
    if (!vw || !vh || !W || !H) return;
    if (fitScale() >= READABLE_SCALE) {
      fit(false);
      layoutMode.current = "initial";
      return;
    }
    const wide = W / H > vw / vh;
    const shortSide = wide ? (vh - FIT_PAD * 2) / H : (vw - FIT_PAD * 2) / W;
    const s = clamp(shortSide, READABLE_SCALE, 1);
    layoutMode.current = "initial";
    apply(
      wide
        ? { s, x: FIT_PAD, y: Math.max(FIT_PAD, (vh - H * s) / 2) }
        : { s, x: Math.max(FIT_PAD, (vw - W * s) / 2), y: FIT_PAD },
      false,
    );
  }, [W, H, fitScale, fit, apply]);

  const zoomAt = useCallback(
    (px: number, py: number, factor: number, animate = false) => {
      const v = view.current;
      const s = clampScale(v.s * factor);
      const k = s / v.s;
      layoutMode.current = null;
      apply({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, animate);
    },
    [apply, clampScale],
  );

  const panBy = useCallback(
    (dx: number, dy: number, animate = false) => {
      const v = view.current;
      layoutMode.current = null;
      apply({ ...v, x: v.x + dx, y: v.y + dy }, animate);
    },
    [apply],
  );

  // 让内容坐标 (cx, cy) 落到视口中心
  const centerOn = useCallback(
    (cx: number, cy: number, scale: number, animate: boolean) => {
      const { w: vw, h: vh } = stageSize.current;
      const s = clampScale(scale);
      layoutMode.current = null;
      apply({ s, x: vw / 2 - cx * s, y: vh / 2 - cy * s }, animate);
    },
    [apply, clampScale],
  );

  const zoomCenter = (factor: number) =>
    zoomAt(stageSize.current.w / 2, stageSize.current.h / 2, factor, true);
  const actualSize = () => zoomCenter(1 / view.current.s);

  // 尺寸：首帧前排好初始视图；之后跟着容器变化（还在自动布局 → 按原规则重排，
  // 用户动过 → 保持视口中心点）
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const prev = stageSize.current;
      // clientWidth 是布局尺寸，不受外层弹窗入场缩放动画影响
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (w === prev.w && h === prev.h && prev.w !== 0) return;
      stageSize.current = { w, h };
      if (prev.w === 0 || layoutMode.current === "initial") {
        initialView();
      } else if (layoutMode.current === "fit") {
        fit(false);
      } else {
        const v = view.current;
        apply({ ...v, x: v.x + (w - prev.w) / 2, y: v.y + (h - prev.h) / 2 }, false);
      }
    };
    stageSize.current = { w: 0, h: 0 };
    layoutMode.current = "initial";
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [initialView, fit, apply]);

  useEffect(
    () => () => {
      if (uiFrame.current) cancelAnimationFrame(uiFrame.current);
    },
    [],
  );

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // ── 指针：拖拽平移 / 双指捏合 / 触屏双击轻点 ──
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; cx: number; cy: number } | null>(null);
  const travel = useRef(0);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const localPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  };
  const pinchOf = () => {
    const [a, b] = Array.from(pointers.current.values());
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    settleAnimation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 指针已失效（辅助技术合成的事件等）：不捕获也能拖，只是出界会丢
    }
    const [px, py] = localPoint(e);
    pointers.current.set(e.pointerId, { x: px, y: py });
    if (pointers.current.size === 1) travel.current = 0;
    if (pointers.current.size === 2) pinch.current = pinchOf();
    setDragging(true);
    setInteracted(true);
    // 点过画布后键盘快捷键（+ − 0 1 方向键）立即可用
    rootRef.current?.focus({ preventScroll: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const [px, py] = localPoint(e);
    pointers.current.set(e.pointerId, { x: px, y: py });
    if (pointers.current.size === 1) {
      travel.current += Math.abs(px - prev.x) + Math.abs(py - prev.y);
      panBy(px - prev.x, py - prev.y);
    } else if (pointers.current.size === 2 && pinch.current) {
      // 先以旧中点为圆心缩放，再把旧中点平移到新中点：两指下的内容始终跟手
      const next = pinchOf();
      travel.current = Infinity;
      zoomAt(pinch.current.cx, pinch.current.cy, next.d / pinch.current.d);
      panBy(next.cx - pinch.current.cx, next.cy - pinch.current.cy);
      pinch.current = next;
    }
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 2) pinch.current = pinchOf();
    else pinch.current = null;
    if (pointers.current.size > 0) return;
    setDragging(false);
    // 触屏双击轻点放大（鼠标走原生 dblclick）
    if (e.pointerType !== "touch" || e.type !== "pointerup" || travel.current > 10) return;
    const [px, py] = localPoint(e);
    const last = lastTap.current;
    if (last && e.timeStamp - last.t < 320 && Math.hypot(px - last.x, py - last.y) < 32) {
      lastTap.current = null;
      zoomAt(px, py, 2, true);
    } else {
      lastTap.current = { t: e.timeStamp, x: px, y: py };
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const [px, py] = localPoint(e);
    zoomAt(px, py, e.shiftKey || e.altKey ? 0.5 : 2, true);
  };

  // ── 滚轮 / 触控板：要 preventDefault 只能挂原生非 passive 监听 ──
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let gestureBase = 0;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      settleAnimation();
      setInteracted(true);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        // 触控板捏合在 Chrome / Firefox 里就是 ctrl + wheel；鼠标 ⌘/Ctrl + 滚轮一格按 ~1.28×
        if (gestureBase) return;
        const [px, py] = local(e);
        zoomAt(px, py, Math.exp(-clamp(dy, -25, 25) * 0.01));
        return;
      }
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      panBy(-dx, -dy);
    };
    // Safari 的触控板捏合不发 ctrl+wheel，只发非标准的 gesture* 事件；
    // iOS 上双指捏合两路都会发，指针那一路已经处理，这里只拦默认行为。
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      settleAnimation();
      gestureBase = view.current.s;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (pointers.current.size >= 2 || !gestureBase) return;
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = local(g);
      zoomAt(px, py, (gestureBase * g.scale) / view.current.s);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureBase = 0;
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    stage.addEventListener("gestureend", onGestureEnd);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
    };
  }, [zoomAt, panBy, settleAnimation]);

  // ── 查找节点（仅内联 SVG）──
  const searchable = source.kind === "inline";
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Box[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  const openSearch = () => {
    setSearchOpen(true);
    setInteracted(true);
    // 已经开着时重新聚焦并全选，方便直接改词
    requestAnimationFrame(() => {
      const input = searchBoxRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    rootRef.current?.focus({ preventScroll: true });
  };

  // 命中框太小看不清就拉到 100%，框比视口还大就缩到放得下
  const focusBox = useCallback(
    (b: Box) => {
      const { w: vw, h: vh } = stageSize.current;
      const fitBox = Math.min((vw * 0.8) / Math.max(b.w, 1), (vh * 0.8) / Math.max(b.h, 1));
      let s = view.current.s;
      if (s < Math.min(1, fitBox)) s = Math.min(1, fitBox);
      if (s > fitBox) s = fitBox;
      centerOn(b.x + b.w / 2, b.y + b.h / 2, s, true);
    },
    [centerOn],
  );

  const svgMarkup = source.kind === "inline" ? source.svg : null;
  const needle = searchable && searchOpen ? squash(query) : "";
  useEffect(() => {
    if (!needle) return;
    const q = needle;
    const timer = window.setTimeout(() => {
      const layer = layerRef.current;
      const svg = layer?.querySelector("svg");
      if (!layer || !svg) return;
      const layerRect = layer.getBoundingClientRect();
      // 用实测比例而不是 view.s：缩放动画进行中也换算得准
      const k = layerRect.width / W || 1;
      const seen = new Set<Element>();
      const boxes: Box[] = [];
      svg.querySelectorAll("text, foreignObject").forEach((el) => {
        if (!squash(el.textContent ?? "").includes(q)) return;
        const target = el.closest(HIT_GROUP) ?? el;
        if (seen.has(target)) return;
        seen.add(target);
        const r = target.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        boxes.push({
          x: (r.left - layerRect.left) / k,
          y: (r.top - layerRect.top) / k,
          w: r.width / k,
          h: r.height / k,
        });
      });
      // 阅读顺序：先上后下（同一行容忍 12px 的错位），再从左到右
      boxes.sort((a, b) => Math.round(a.y / 12) - Math.round(b.y / 12) || a.x - b.x);
      setHits(boxes);
      setHitIndex(0);
      if (boxes.length > 0) focusBox(boxes[0]);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [needle, svgMarkup, W, focusBox]);
  // 清空查询 / 关掉查找框时不再画命中框（不必在 effect 里同步清 state）
  const visibleHits = needle ? hits : [];

  const stepHit = (delta: number) => {
    if (visibleHits.length === 0) return;
    const i = (hitIndex + delta + visibleHits.length) % visibleHits.length;
    setHitIndex(i);
    focusBox(visibleHits[i]);
  };

  // ── 键盘 ──
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && searchable) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 焦点在工具条按钮上时，回车 / 空格留给按钮
    if (t !== rootRef.current && t.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    const { w, h } = stageSize.current;
    const step = e.shiftKey ? 240 : 60;
    switch (e.key) {
      case "+":
      case "=":
        zoomAt(w / 2, h / 2, ZOOM_STEP, true);
        break;
      case "-":
      case "_":
        zoomAt(w / 2, h / 2, 1 / ZOOM_STEP, true);
        break;
      case "0":
        fit(true);
        break;
      case "1":
        actualSize();
        break;
      case "ArrowLeft":
        panBy(step, 0, true);
        break;
      case "ArrowRight":
        panBy(-step, 0, true);
        break;
      case "ArrowUp":
        panBy(0, step, true);
        break;
      case "ArrowDown":
        panBy(0, -step, true);
        break;
      case "/":
        if (!searchable) return;
        openSearch();
        break;
      default:
        return;
    }
    e.preventDefault();
    setInteracted(true);
  };

  // ── 缩略图：图比视口大时才出现 ──
  const { view: v, vw, vh } = ui;
  const overflowing = vw > 0 && (W * v.s > vw + 2 || H * v.s > vh + 2);
  const [minimapOn, setMinimapOn] = useState(true);
  const showMinimap = overflowing && minimapOn;
  // 依赖内容字符串而不是 source 对象：父组件每次渲染都传新对象，平移时这里每帧重渲
  const markup = source.kind === "image" ? source.src : source.svg;
  const minimapSrc = useMemo(() => {
    if (!showMinimap) return null;
    return source.kind === "image" ? markup : svgToDataUrl(markup);
  }, [showMinimap, source.kind, markup]);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="region"
      aria-roledescription="可缩放画布"
      aria-label={`${label}：拖拽平移，⌘ 或 Ctrl 加滚轮缩放，0 适应窗口`}
      onKeyDown={onKeyDown}
      className={cn("relative overflow-hidden outline-none focus-visible:outline-none", className)}
      data-diagram-canvas
    >
      <div
        ref={stageRef}
        className={cn(
          "absolute inset-0 touch-none select-none overflow-hidden",
          DIAGRAM_BACKGROUND_CLASS[background],
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onDoubleClick}
      >
        <div
          ref={layerRef}
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ width: W, height: H }}
        >
          {source.kind === "inline" ? (
            <InlineSvg svg={source.svg} />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={source.src}
              alt={label}
              width={W}
              height={H}
              draggable={false}
              className="block h-full w-full"
            />
          )}
          {visibleHits.map((b, i) => (
            <div
              key={`${b.x}-${b.y}-${i}`}
              className={cn("diagram-hit", i === hitIndex && "diagram-hit-current")}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            />
          ))}
        </div>
      </div>

      {searchable && searchOpen && (
        <div
          ref={searchBoxRef}
          data-esc-local
          className="absolute right-3 top-3 z-10 flex w-72 max-w-[calc(100%-1.5rem)] items-center gap-0.5 rounded-overlay border border-line bg-surface-raised p-1 shadow-pop"
        >
          <Input
            size="sm"
            autoFocus
            value={query}
            placeholder="查找节点文字"
            aria-label="查找节点文字"
            wrapperClassName="flex-1 min-w-0 border-transparent"
            leading={<Icon icon={Search} size="sm" />}
            trailing={
              needle ? (
                <span className="font-mono text-nano tabular-nums">
                  {visibleHits.length ? hitIndex + 1 : 0}/{visibleHits.length}
                </span>
              ) : undefined
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }
            }}
          />
          <IconButton size="sm" label="上一个" shortcut="⇧↵" disabled={visibleHits.length < 2} onClick={() => stepHit(-1)}>
            <Icon icon={ChevronUp} size="sm" />
          </IconButton>
          <IconButton size="sm" label="下一个" shortcut="↵" disabled={visibleHits.length < 2} onClick={() => stepHit(1)}>
            <Icon icon={ChevronDown} size="sm" />
          </IconButton>
          <IconButton size="sm" label="关闭查找" shortcut="Esc" onClick={closeSearch}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>
      )}

      <div
        className={cn(
          "pointer-events-none absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-field border border-line bg-surface-raised px-2 py-1 text-label text-ink-muted shadow-pop transition-opacity duration-500 max-md:hidden",
          interacted ? "opacity-0" : "opacity-100",
        )}
      >
        {coarse
          ? "单指拖动 · 双指缩放 · 双击放大"
          : "拖拽平移 · ⌘/Ctrl + 滚轮或双指捏合缩放 · 双击放大"}
      </div>

      <div className="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2">
        {showMinimap && minimapSrc && (
          <Minimap
            src={minimapSrc}
            width={W}
            height={H}
            maxWidth={Math.min(MINIMAP_W, vw * 0.45)}
            maxHeight={Math.min(MINIMAP_H, vh * 0.25)}
            view={v}
            viewportW={vw}
            viewportH={vh}
            onJump={(cx, cy) => centerOn(cx, cy, view.current.s, false)}
          />
        )}
        <div className="flex items-center gap-0.5 rounded-overlay border border-line bg-surface-raised p-0.5 shadow-pop">
          <IconButton size="sm" label="缩小" shortcut="−" onClick={() => zoomCenter(1 / ZOOM_STEP)}>
            <Icon icon={Minus} size="sm" />
          </IconButton>
          <span className="min-w-11 text-center font-mono text-label tabular-nums text-ink-muted" aria-live="polite">
            {Math.round(v.s * 100)}%
          </span>
          <IconButton size="sm" label="放大" shortcut="+" onClick={() => zoomCenter(ZOOM_STEP)}>
            <Icon icon={Plus} size="sm" />
          </IconButton>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <IconButton size="sm" label="适应窗口" shortcut="0" onClick={() => fit(true)}>
            <Icon icon={Scan} size="sm" />
          </IconButton>
          <IconButton size="sm" label="实际大小" shortcut="1" onClick={actualSize}>
            <span className="font-mono text-nano leading-none">1:1</span>
          </IconButton>
          {(overflowing || searchable) && <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />}
          {overflowing && (
            <IconButton
              size="sm"
              label={minimapOn ? "隐藏缩略图" : "显示缩略图"}
              aria-pressed={minimapOn}
              onClick={() => setMinimapOn((on) => !on)}
            >
              <Icon icon={MapIcon} size="sm" />
            </IconButton>
          )}
          {searchable && (
            <IconButton size="sm" label="查找节点" shortcut="/" onClick={openSearch}>
              <Icon icon={Search} size="sm" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

// SVG 串不变就不重建 DOM：拖拽 / 缩放只动外层 transform，不触发这里重渲染。
const InlineSvg = memo(function InlineSvg({ svg }: { svg: string }) {
  return <div className="h-full w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
});

// 缩略图：整图 + 当前视口框；点 / 拖缩略图任意位置，视图中心跳过去。
function Minimap({
  src,
  width,
  height,
  maxWidth,
  maxHeight,
  view,
  viewportW,
  viewportH,
  onJump,
}: {
  src: string;
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  view: View;
  viewportW: number;
  viewportH: number;
  onJump: (cx: number, cy: number) => void;
}) {
  const m = Math.min(maxWidth / width, maxHeight / height);
  const w = Math.max(24, width * m);
  const h = Math.max(24, height * m);
  const jump = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onJump((e.clientX - r.left) / m, (e.clientY - r.top) / m);
  };
  return (
    <div
      aria-hidden
      className="relative cursor-pointer touch-none select-none overflow-hidden rounded-field border border-line bg-surface-raised shadow-pop"
      style={{ width: w, height: h }}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 同上：捕获失败不影响点一下就跳
        }
        jump(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) jump(e);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: width * m, height: height * m }}
      />
      <div
        className="diagram-minimap-viewport"
        style={{
          left: (-view.x / view.s) * m,
          top: (-view.y / view.s) * m,
          width: (viewportW / view.s) * m,
          height: (viewportH / view.s) * m,
        }}
      />
    </div>
  );
}
