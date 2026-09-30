"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ShieldAlert, Undo2, X } from "lucide-react";
import { Icon, cn, toast } from "@/components/ui";
import { useHerdrPaneLongPress } from "./HerdrPaneMenu";
import { overflowX, useGesturesEnabled, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import {
  DEFAULT_SWIPE_THRESHOLD,
  SWIPE_UNDO_MS,
  deferAction,
  highRiskMatches,
  isEdgeStart,
  rubberBand,
  startsInHorizontalScroller,
  type DeferredAction,
} from "@/lib/gestures";
import type { HerdrConsolePane } from "@/lib/herdr-console";

// 「需要你」卡片的外层滑动容器（/herdr 总览卡 + 会话页顶部卡共用）：
//   右滑 = 允许、左滑 = 拒绝，只对权限审批卡启用（提问卡选项不止两个，不启用）；
//   过阈值松手 → 3 秒撤销 toast，撤销期内什么都不发，到时才「点」卡片自己的允许 / 拒绝按钮
//   （复用卡片内部的发键动作：hook 卡直发、读屏卡先核对屏幕没变再发，不在这里拼按键）；
//   高风险命令（lib/gestures isHighRiskCommand）不响应滑动，只能点按钮。
// 这里只读卡片 DOM 上的约定标记，不改卡片内部渲染与数据：
//   [data-herdr-approval]                       审批块（文字即判风险的依据）
//   [data-mobile-target=herdr-permission-allow] 允许按钮
//   [data-mobile-target=herdr-permission-deny]  拒绝按钮
const APPROVAL = "[data-herdr-approval]";
const ALLOW = '[data-mobile-target="herdr-permission-allow"]';
const DENY = '[data-mobile-target="herdr-permission-deny"]';

type SwipeKind = "allow" | "deny";
type ApprovalDom = { block: HTMLElement; allow: HTMLButtonElement; deny: HTMLButtonElement; text: string };

function readApproval(root: HTMLElement): ApprovalDom | null {
  const block = root.querySelector<HTMLElement>(APPROVAL);
  const allow = block?.querySelector<HTMLButtonElement>(ALLOW);
  const deny = block?.querySelector<HTMLButtonElement>(DENY);
  if (!block || !allow || !deny) return null;
  return { block, allow, deny, text: block.textContent ?? "" };
}

/** 起点落在一张可滑的审批卡上：会话页的窗格滑动据此让位。 */
export function swipeCardOwns(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const card = target.closest<HTMLElement>("[data-herdr-swipe-card]");
  return Boolean(card && card.dataset.herdrSwipeEnabled === "true" && readApproval(card));
}

export function HerdrSwipeCard({
  pane,
  readOnly,
  available,
  where,
  children,
  className,
}: {
  /** 长按菜单与 toast 文案用；null 时只有滑动、没有长按菜单 */
  pane: HerdrConsolePane | null;
  readOnly: boolean;
  available: boolean;
  /** toast 里说明是哪个窗格 */
  where?: string;
  children: ReactNode;
  className?: string;
}) {
  const gestures = useGesturesEnabled();
  const reduced = usePrefersReducedMotion();
  const enabled = gestures && !readOnly;
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ risk: string[]; text: string } | null>(null);
  const deferred = useRef<DeferredAction | null>(null);
  const [drag, setDrag] = useState<{ offset: number; kind: SwipeKind | "risk"; armed: boolean } | null>(null);
  const [pending, setPending] = useState<SwipeKind | null>(null);
  const longPress = useHerdrPaneLongPress(pane, readOnly, available, gestures);

  // 离开卡片（切窗格 / 卡片卸载）时撤销期内的动作一律作废：看不见的卡不替你按。
  useEffect(
    () => () => {
      const d = deferred.current;
      deferred.current = null;
      if (d?.cancel()) toast("已取消滑动操作", { description: "离开了卡片，没有发送任何按键" });
    },
    [],
  );

  const setOffset = (offset: number, animate: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = animate && !reduced ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    track.style.transform = offset ? `translateX(${offset}px)` : "";
  };

  const schedule = (kind: SwipeKind, snapshot: string) => {
    const label = kind === "allow" ? "允许" : "拒绝";
    const toastId = toast(`${SWIPE_UNDO_MS / 1000} 秒后${label}`, {
      description: where ? `${where} · 撤销期内不会发送` : "撤销期内不会发送",
      duration: SWIPE_UNDO_MS,
      action: {
        label: "撤销",
        onClick: () => {
          if (deferred.current?.cancel()) {
            deferred.current = null;
            toast("已撤销，没有发送");
          }
        },
      },
    });
    const d = deferAction(
      () => {
        deferred.current = null;
        setPending(null);
        toast.dismiss(toastId);
        const root = rootRef.current;
        const now = root ? readApproval(root) : null;
        const button = now ? (kind === "allow" ? now.allow : now.deny) : null;
        // 撤销期内卡片换了（新审批 / 已在别处处理）→ 不发
        if (!now || now.text !== snapshot || !button || button.disabled) {
          toast.error(`没有${label}`, { description: "卡片在撤销期内变了，请看清后再操作" });
          return;
        }
        button.click();
      },
      {
        delayMs: SWIPE_UNDO_MS,
        onCancel: () => {
          setPending(null);
          toast.dismiss(toastId);
        },
      },
    );
    deferred.current = d;
    setPending(kind);
  };

  const undo = () => {
    if (deferred.current?.cancel()) {
      deferred.current = null;
      toast("已撤销，没有发送");
    }
  };

  useSwipe(rootRef, {
    enabled,
    axis: "x",
    canStart: (e, el) => {
      if (deferred.current) return false;
      if (isEdgeStart(e.clientX)) return false; // 左缘右拉归侧栏
      const approval = readApproval(el);
      if (!approval || approval.allow.disabled) return false;
      if (startsInHorizontalScroller(e.target as HTMLElement, el, overflowX)) return false;
      if ((e.target as Element).closest("input, textarea, [contenteditable=true]")) return false;
      gesture.current = { risk: highRiskMatches(approval.text), text: approval.text };
      return true;
    },
    onMove: (delta) => {
      const g = gesture.current;
      if (!g) return;
      if (g.risk.length) {
        const offset = rubberBand(delta, 20);
        setOffset(offset, false);
        setDrag({ offset, kind: "risk", armed: false });
        return;
      }
      const width = rootRef.current?.clientWidth ?? 320;
      const offset = Math.max(-width, Math.min(width, delta));
      setOffset(offset, false);
      const armed = Math.abs(delta) >= Math.max(DEFAULT_SWIPE_THRESHOLD.minDistance, width * DEFAULT_SWIPE_THRESHOLD.ratio);
      setDrag({ offset, kind: delta > 0 ? "allow" : "deny", armed });
    },
    onEnd: ({ commit }) => {
      const g = gesture.current;
      gesture.current = null;
      setOffset(0, true);
      setDrag(null);
      if (!g) return;
      if (g.risk.length) {
        toast.warning("高风险命令不支持滑动", { description: `命中：${g.risk.join("、")}。请看清命令后点按钮。` });
        return;
      }
      if (commit === 0) return;
      schedule(commit > 0 ? "allow" : "deny", g.text);
    },
  });

  const reveal = drag?.kind === "allow" ? "allow" : drag?.kind === "deny" ? "deny" : drag?.kind === "risk" ? "risk" : null;

  return (
    <div
      ref={rootRef}
      data-herdr-swipe-card
      data-herdr-swipe-enabled={enabled ? "true" : undefined}
      data-herdr-swipe-pending={pending ?? undefined}
      className={cn("relative isolate", enabled && "overflow-hidden rounded-card [-webkit-touch-callout:none]", className)}
      style={enabled ? { touchAction: "pan-y pinch-zoom" } : undefined}
      {...longPress.bind}
    >
      {reveal && (
        <div
          aria-hidden
          data-herdr-swipe-reveal={reveal}
          className={cn(
            "absolute inset-0 -z-10 flex items-center rounded-card px-5 text-ui font-semibold",
            reveal === "allow" && "justify-start bg-positive text-white",
            reveal === "deny" && "justify-end bg-danger text-white",
            reveal === "risk" && "justify-center bg-warn-muted text-warn-ink",
            drag && !drag.armed && reveal !== "risk" && "opacity-60",
          )}
        >
          {reveal === "allow" && (
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={Check} size="sm" />
              {drag?.armed ? "松手允许" : "允许"}
            </span>
          )}
          {reveal === "deny" && (
            <span className="inline-flex items-center gap-1.5">
              {drag?.armed ? "松手拒绝" : "拒绝"}
              <Icon icon={X} size="sm" />
            </span>
          )}
          {reveal === "risk" && (
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={ShieldAlert} size="sm" />
              高风险命令，请点按钮
            </span>
          )}
        </div>
      )}
      <div ref={trackRef} className="relative bg-surface-canvas">
        {pending && (
          <div
            role="status"
            data-herdr-swipe-undo={pending}
            className={cn(
              "flex items-center gap-2 border-b px-3.5 py-1.5 text-label",
              pending === "allow" ? "border-positive-line bg-positive-muted text-ink" : "border-danger-line bg-danger-muted text-ink",
            )}
          >
            <Icon icon={pending === "allow" ? Check : X} size="sm" className={pending === "allow" ? "text-positive" : "text-danger"} />
            <span className="min-w-0 flex-1 truncate">
              {SWIPE_UNDO_MS / 1000} 秒后{pending === "allow" ? "允许" : "拒绝"}，撤销期内不发送
            </span>
            <button
              type="button"
              data-herdr-swipe-undo-button
              onClick={undo}
              className="inline-flex min-h-8 items-center gap-1 rounded-field px-2 font-medium text-accent hover:bg-surface-hover"
            >
              <Icon icon={Undo2} size="sm" />
              撤销
            </button>
          </div>
        )}
        {children}
      </div>
      {longPress.menu}
    </div>
  );
}
