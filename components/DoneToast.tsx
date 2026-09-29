"use client";
import { useEffect, useMemo, useRef } from "react";
import { ClipboardList, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { Icon, toast } from "@/components/ui";
import type { ChatNode } from "@/lib/types";
import {
  enableDesktopNotify,
  markDesktopNotifyOffered,
  shouldOfferDesktopNotify,
  showDesktopNotification,
} from "@/lib/desktop-notify";

// 用户没盯着的节点跑完 / 停下来等人时的提醒。W4 起不自己画 UI：只把
// store.doneToasts 同步进全站 sonner 队列（右下角，与其他 toast 同一堆叠）。
//
// kind "done"    → 「#N 已完成」+ 话题 / 问题前缀，6 秒自动消失。
// kind "waiting" → run 暂停在交互式工具（提问 / 计划批准 / 权限授权）等用户
//   回答。不自动消失——run 阻塞着，提醒消失了用户就再也不知道有事等他。
//   回答 / 终结后由 store 清除，这里跟着 dismiss。
// 「查看」→ 聚焦该节点、切回线性视图、关掉提醒。
// 页面在后台时同一条提醒再发一份系统通知（lib/desktop-notify.ts），点开等同「查看」。
//
// 为什么 6 秒：典型场景是「问完一个问题、分叉出去、回头读另一张卡」，用户需要
// 时间注意到提醒再决定要不要打断手头的阅读。6s 落在常见 toast 时长的偏长一端。
const AUTO_DISMISS_MS = 6000;

type Entry = { key: string; toastId: string; emittedAt: number };

export function DoneToast() {
  const toasts = useSessionStore((s) => s.doneToasts);
  const nodes = useSessionStore((s) => s.nodes);
  // 只在树真的变了时重算编号。
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  // nodeId → 当前挂在 sonner 里的那条（签名变了才重发，避免每次 nodes 变动都刷新计时）。
  const shown = useRef(new Map<string, Entry>());

  useEffect(() => {
    const live = new Set<string>();
    for (const t of toasts) {
      live.add(t.nodeId);
      const node = nodes[t.nodeId];
      const waiting = t.kind === "waiting";
      const index = indices[t.nodeId] ?? 0;
      const title = waiting ? waitingTitle(node) : "已完成";
      const label = topicForNode(node);
      const key = `${t.kind ?? "done"}|${t.emittedAt}|${index}|${title}|${label}`;
      const prev = shown.current.get(t.nodeId);
      if (prev?.key === key) continue;

      // 同一节点重新提醒（重跑 / done↔waiting 切换）时 emittedAt 会变：换一个新
      // toast id，让 sonner 从头计时；旧的那条先撤掉。
      const toastId = `done:${t.nodeId}:${t.emittedAt}`;
      if (prev && prev.toastId !== toastId) toast.dismiss(prev.toastId);
      shown.current.set(t.nodeId, { key, toastId, emittedAt: t.emittedAt });

      const nodeId = t.nodeId;
      const emittedAt = t.emittedAt;
      // 用户点 × / 自动消失 → 同步清 store。只清「还是这一条」的那项，避免旧 toast
      // 被替换时误删刚发出的新提醒。
      const clear = () => {
        const cur = shown.current.get(nodeId);
        if (cur?.toastId === toastId) shown.current.delete(nodeId);
        const st = useSessionStore.getState();
        if (st.doneToasts.some((x) => x.nodeId === nodeId && x.emittedAt === emittedAt)) {
          st.dismissDoneToast(nodeId);
        }
      };
      const view = () => {
        const st = useSessionStore.getState();
        st.setActiveNode(nodeId);
        st.setViewMode("linear");
        clear();
      };
      if (document.hidden) {
        showDesktopNotification({
          title: `${index ? `#${index} ` : ""}${title}`,
          body: label || undefined,
          tag: toastId,
          onClick: view,
        });
      } else if (shouldOfferDesktopNotify()) {
        markDesktopNotifyOffered();
        toast.info("页面在后台时也提醒你？", {
          description: "跑完或等你处理时弹系统通知；偏好页里随时可关",
          duration: 10000,
          action: {
            label: "开启",
            onClick: () => void enableDesktopNotify(),
          },
        });
      }
      const titleNode = (
        <span className="flex items-center gap-1.5">
          {index ? <span className="font-mono tabular-nums text-ink-faint">#{index}</span> : null}
          <span>{title}</span>
        </span>
      );
      const opts = {
        id: toastId,
        description: label || undefined,
        duration: waiting ? Infinity : Math.max(1000, AUTO_DISMISS_MS - (Date.now() - emittedAt)),
        action: {
          label: waiting ? "去处理" : "查看",
          onClick: view,
        },
        onDismiss: clear,
        onAutoClose: clear,
      };
      if (waiting) {
        toast.warning(titleNode, {
          ...opts,
          icon: <Icon icon={waitingIcon(node)} className="text-warn" />,
        });
      } else {
        toast.success(titleNode, opts);
      }
    }
    // store 里没了（回答了 / 被别处清掉）→ 撤掉对应 toast。
    for (const [nodeId, e] of shown.current) {
      if (!live.has(nodeId)) {
        shown.current.delete(nodeId);
        toast.dismiss(e.toastId);
      }
    }
  }, [toasts, nodes, indices]);
  // 不在卸载时 dismiss：toast.dismiss 会回调 onDismiss 把 store 也清掉，StrictMode
  // 的假卸载会因此吞掉提醒。主页面只在整页跳转时卸载，sonner 队列随之销毁。

  return null;
}

// 文案按暂停在哪个交互式工具上区分；node / pendingInteraction 已被清时给兜底。
function waitingTitle(n: ChatNode | undefined): string {
  const tool = n?.pendingInteraction?.toolName;
  if (tool === "AskUserQuestion") return "等你回答";
  if (tool === "ExitPlanMode") return "等你批准计划";
  return "等待工具授权";
}

function waitingIcon(n: ChatNode | undefined) {
  const tool = n?.pendingInteraction?.toolName;
  if (tool === "AskUserQuestion") return MessageCircleQuestion;
  if (tool === "ExitPlanMode") return ClipboardList;
  return ShieldAlert;
}

function topicForNode(n: ChatNode | undefined): string {
  if (!n) return "";
  if (n.kind === "reference") {
    return n.topicLabel ?? "参考材料";
  }
  return n.topicLabel ?? truncate(n.question, 40);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
