"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// 右键菜单原语：任何行 / 节点都能挂。与 Popover 的区别有两点 —— Popover 锚在
// trigger 元素上（下拉），这里锚在指针坐标上（右键 / 长按）；Popover 用相对
// 定位就够了，这里必须 portal 到 body：侧栏与结构面板都是 overflow 滚动容器，
// 绝对定位的菜单会被裁掉。
//
// open 状态由 useContextMenu 持有，消费方只管把 onContextMenu 挂到元素上、
// 把 items 传给 <ContextMenu>。点选项后自动关闭；Esc / 点外面 / 滚动 / 缩放
// 窗口也关闭（滚动后菜单会脱离原来的行，关掉比跟着跑更不出错）。
//
// 用法：
//   const menu = useContextMenu();
//   <div onContextMenu={menu.onContextMenu}>…</div>
//   <ContextMenu {...menu.props} items={[
//     { label: "重命名", onSelect: rename },
//     "separator",
//     { label: "删除", danger: true, onSelect: remove },
//   ]} />
//
// 手机长按等非右键入口用 menu.openAt({ x, y })。

export type ContextMenuAction = {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** 右侧灰字：快捷键或补充说明 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
};
export type ContextMenuItem = ContextMenuAction | "separator";
export type ContextMenuPoint = { x: number; y: number };

export type ContextMenuTriggerBindings<TargetElement extends Element = HTMLElement> = {
  onContextMenu: (e: ReactMouseEvent<TargetElement>) => void;
  onTouchStart: (e: ReactTouchEvent<TargetElement>) => void;
  onTouchMove: (e: ReactTouchEvent<TargetElement>) => void;
  onTouchEnd: (e: ReactTouchEvent<TargetElement>) => void;
  onTouchCancel: () => void;
  onClickCapture: (e: ReactMouseEvent<TargetElement>) => void;
};

const EDGE_MARGIN = 8;

export function useContextMenu() {
  const [point, setPoint] = useState<ContextMenuPoint | null>(null);
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPoint({ x: e.clientX, y: e.clientY });
  }, []);
  const openAt = useCallback((p: ContextMenuPoint) => setPoint(p), []);
  const close = useCallback(() => setPoint(null), []);
  const props = useMemo(() => ({ point, onClose: close }), [point, close]);
  return useMemo(
    () => ({
      open: point !== null,
      point,
      onContextMenu,
      openAt,
      close,
      props,
    }),
    [point, onContextMenu, openAt, close, props],
  );
}

/**
 * 带目标对象的上下文菜单 Hook，同时支持：
 * 1. 桌面右键菜单（onContextMenu，阻止默认行为）
 * 2. 移动端 500ms 长按（onTouchStart/Move/End，允许自然滚动，>10px 判定为滚动并取消长按，长按触发后抑制 click）
 */
export function useContextMenuWithTarget<T, E extends HTMLElement = HTMLElement>() {
  const menu = useContextMenu();
  const [target, setTarget] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<ContextMenuPoint | null>(null);
  const suppressClickUntilRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const menuClose = menu.close;
  const menuOpenAt = menu.openAt;

  const close = useCallback(() => {
    menuClose();
    setTarget(null);
  }, [menuClose]);

  const bindTrigger = useCallback(
    <TargetElement extends Element = E>(
      item: T,
    ): ContextMenuTriggerBindings<TargetElement> => ({
      onContextMenu: (e: ReactMouseEvent<TargetElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setTarget(item);
        menuOpenAt({ x: e.clientX, y: e.clientY });
      },
      onTouchStart: (e: ReactTouchEvent<TargetElement>) => {
        const touch = e.touches[0];
        if (!touch) return;
        startPosRef.current = { x: touch.clientX, y: touch.clientY };
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (!startPosRef.current) return;
          setTarget(item);
          menuOpenAt(startPosRef.current);
          suppressClickUntilRef.current = Date.now() + 600;
        }, 500);
      },
      onTouchMove: (e: ReactTouchEvent<TargetElement>) => {
        if (!startPosRef.current || !timerRef.current) return;
        const touch = e.touches[0];
        if (!touch) return;
        const dx = Math.abs(touch.clientX - startPosRef.current.x);
        const dy = Math.abs(touch.clientY - startPosRef.current.y);
        if (dx > 10 || dy > 10) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      },
      onTouchEnd: (e: ReactTouchEvent<TargetElement>) => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (Date.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
        startPosRef.current = null;
      },
      onTouchCancel: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        startPosRef.current = null;
      },
      onClickCapture: (e: ReactMouseEvent<TargetElement>) => {
        if (Date.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [menuOpenAt],
  );

  const props = useMemo(
    () => ({
      point: menu.point,
      onClose: close,
    }),
    [menu.point, close],
  );

  return useMemo(
    () => ({
      open: menu.open,
      point: menu.point,
      onContextMenu: menu.onContextMenu,
      openAt: menu.openAt,
      close,
      target,
      setTarget,
      bindTrigger,
      props,
    }),
    [
      menu.open,
      menu.point,
      menu.onContextMenu,
      menu.openAt,
      close,
      target,
      bindTrigger,
      props,
    ],
  );
}

function isAction(it: ContextMenuItem): it is ContextMenuAction {
  return it !== "separator";
}

export function ContextMenu({
  point,
  onClose,
  items,
  label,
}: {
  point: ContextMenuPoint | null;
  onClose: () => void;
  items: ContextMenuItem[];
  /** aria-label；同一页面多个菜单时用来区分 */
  label?: string;
}) {
  if (point === null) return null;
  // key 随坐标变：换个位置再次右键时，面板整体重建，高亮项自然归零。
  return createPortal(
    <MenuPanel
      key={`${point.x}:${point.y}`}
      point={point}
      onClose={onClose}
      items={items}
      label={label}
    />,
    document.body,
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function MenuPanel({
  point,
  onClose,
  items,
  label,
}: {
  point: ContextMenuPoint;
  onClose: () => void;
  items: ContextMenuItem[];
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);

  // 先按指针坐标渲染（不可见），量完尺寸再夹回视口 —— 靠近右缘 / 下缘时向内翻。
  // 直接写 DOM 样式而不经 state：这是一次性的布局修正，不需要再触发渲染。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = clamp(point.x, EDGE_MARGIN, window.innerWidth - r.width - EDGE_MARGIN);
    const y = clamp(point.y, EDGE_MARGIN, window.innerHeight - r.height - EDGE_MARGIN);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
  }, [point]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // 键盘导航以 DOM 为准（role=menuitem + data-active），不用再复制一份 items 状态。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const el = ref.current;
      if (!el) return;
      const buttons = Array.from(
        el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
      );
      if (buttons.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const cur = buttons.findIndex((b) => b.dataset.active === "true");
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next =
          cur < 0
            ? step > 0
              ? 0
              : buttons.length - 1
            : (cur + step + buttons.length) % buttons.length;
        setActive(Number(buttons[next].dataset.index));
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const cur = buttons.find((b) => b.dataset.active === "true");
        if (cur) {
          e.preventDefault();
          e.stopPropagation();
          cur.click();
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid="context-menu"
      className="fixed z-[80] min-w-40 max-w-64 py-1 bg-surface-raised border border-line rounded-lg shadow-pop ui-enter-pop text-ui"
      style={{ left: point.x, top: point.y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        isAction(it) ? (
          <button
            key={`${it.label}-${i}`}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            data-index={i}
            data-active={active === i ? "true" : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onSelect();
            }}
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
              it.danger ? "text-danger" : "text-ink"
            } ${active === i ? "bg-surface-muted" : ""}`}
          >
            {it.icon && (
              <span className="shrink-0 text-ink-muted">{it.icon}</span>
            )}
            <span className="flex-1 truncate">{it.label}</span>
            {it.hint && (
              <span className="shrink-0 text-nano text-ink-faint">{it.hint}</span>
            )}
          </button>
        ) : (
          <div
            key={`sep-${i}`}
            role="separator"
            className="my-1 border-t border-line-faint"
          />
        ),
      )}
    </div>
  );
}
