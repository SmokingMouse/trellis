// 运行中追加消息的「排队 / 插话」（参考 Codex 手机端 Queue vs Steer）——纯逻辑。
//
// 排队（queue）：回复进行中继续发送 → 进入该会话的排队列表；当前轮**成功**结束后
// 自动按序发出下一条。出错 / 被停止 → 不自动发，列表标「已暂停」，等用户点「继续发送」。
// 插话（steer）：把消息注入正在跑的那一轮（只有 Agent 服务上的线程支持，见
// lib/server/as-project.ts steerProject）。插话没有本地状态，这里只放偏好的类型与默认值。
//
// 出队规则的核心是 follow ——「下一条要等哪个节点跑完」：
//   - { kind: "node", nodeId }：等这个节点结束。done → 发队首；error → 暂停。
//   - { kind: "childOf", parentId }：刚把队首发出去，新节点的真实 id 还没回来
//     （先是乐观占位，再由 `created` 换成服务端 id）。看到该父节点下的真实子节点就
//     改成 node 跟随。乐观节点一概忽略——它没有服务端 run，也可能被丢弃。
//   - null：队列为空。
// 「看到哪个节点」由调用方每次渲染喂进来（observeQueue 的 target = 输入框的发送目标，
// 线性视图里就是线程末端）。所以即使 mock 一口气跑完、中间那帧 streaming 没被看见，
// childOf → 子节点 done 也能在同一次 observe 里接着发下一条。
//
// 持久化（localStorage，按会话）：items 只存文字 + 已上传附件的 hash 引用，刷新后能
// 原样恢复；follow / paused 一起存，刷新落回同一分支末端时照常续发。

import type { NodeAttachment, NodeStatus } from "@/lib/types";

// ── 偏好：运行中发送的默认方式 ────────────────────────────────────────────────

export type BusySendMode = "queue" | "steer";
export const BUSY_SEND_MODE_DEFAULT: BusySendMode = "queue";

export function isBusySendMode(s: unknown): s is BusySendMode {
  return s === "queue" || s === "steer";
}

// ── 排队状态机 ───────────────────────────────────────────────────────────────

export type QueuedMessage = {
  id: string;
  text: string;
  attachments: NodeAttachment[];
  createdAt: number;
};

export type QueueFollow =
  | { kind: "node"; nodeId: string }
  | { kind: "childOf"; parentId: string | null }
  | null;

export type ComposerQueue = {
  items: QueuedMessage[];
  follow: QueueFollow;
  /** 跟随的那一轮出错 / 被停止：不自动发，等「继续发送」 */
  paused: boolean;
};

export const EMPTY_QUEUE: ComposerQueue = { items: [], follow: null, paused: false };

/** 输入框当前的发送目标（线性视图 = 线程末端）。 */
export type QueueTarget = {
  id: string;
  parentId: string | null;
  status: NodeStatus;
  /** 乐观占位（服务端还没回 `created`） */
  optimistic: boolean;
};

export type QueueAction = { type: "send"; item: QueuedMessage; targetId: string };

export type QueueStep = { queue: ComposerQueue; action: QueueAction | null };

const same = (a: QueueFollow, b: QueueFollow) =>
  a === b ||
  (!!a && !!b && a.kind === b.kind &&
    (a.kind === "node"
      ? a.nodeId === (b as { nodeId: string }).nodeId
      : a.parentId === (b as { parentId: string | null }).parentId));

function followFor(target: QueueTarget): QueueFollow {
  return target.optimistic
    ? { kind: "childOf", parentId: target.parentId }
    : { kind: "node", nodeId: target.id };
}

/** 发出队首后的状态：剩下的等新节点（targetId 的子节点）。 */
function shift(q: ComposerQueue, targetId: string): QueueStep {
  const [item, ...rest] = q.items;
  return {
    queue: { items: rest, follow: rest.length ? { kind: "childOf", parentId: targetId } : null, paused: false },
    action: { type: "send", item, targetId },
  };
}

export function newQueuedMessage(text: string, attachments: NodeAttachment[], now = Date.now()): QueuedMessage {
  return { id: crypto.randomUUID(), text, attachments, createdAt: now };
}

/** 运行中发送 → 入队。队列原本为空时从当前目标开始跟随。 */
export function enqueue(q: ComposerQueue, item: QueuedMessage, target: QueueTarget): ComposerQueue {
  if (q.items.length === 0) return { items: [item], follow: followFor(target), paused: false };
  return { ...q, items: [...q.items, item] };
}

/**
 * 每次发送目标变化（id / status / 乐观态）时调用。返回新状态（没变则原对象）
 * 与可能的动作。调用方必须先提交新状态再执行动作——状态先行保证同一个
 * target 再 observe 一次（StrictMode 双跑 effect）不会重复发送。
 */
export function observeQueue(q: ComposerQueue, target: QueueTarget | null): QueueStep {
  if (q.items.length === 0) {
    return { queue: q.follow || q.paused ? EMPTY_QUEUE : q, action: null };
  }
  if (!target || target.optimistic) return { queue: q, action: null };
  let follow = q.follow;
  if (follow?.kind === "childOf" && target.parentId === follow.parentId) {
    follow = { kind: "node", nodeId: target.id };
  }
  if (target.status === "streaming") {
    // 任何真实的运行中目标都接管跟随：包括暂停后用户手动发了一条、或切到了
    // 另一个正在跑的分支——「排到下一轮」指的就是眼前这一轮。
    const next: QueueFollow = { kind: "node", nodeId: target.id };
    if (same(next, q.follow) && !q.paused) return { queue: q, action: null };
    return { queue: { ...q, follow: next, paused: false }, action: null };
  }
  if (follow?.kind === "node" && follow.nodeId === target.id) {
    if (target.status === "done" && !q.paused) return shift(q, target.id);
    if (target.status === "error") {
      if (q.paused && same(follow, q.follow)) return { queue: q, action: null };
      return { queue: { ...q, follow, paused: true }, action: null };
    }
  }
  if (!same(follow, q.follow)) return { queue: { ...q, follow }, action: null };
  return { queue: q, action: null };
}

/** 「继续发送」：目标空闲就立刻发队首；目标还在跑就只是解除暂停、改跟随它。 */
export function resumeQueue(q: ComposerQueue, target: QueueTarget | null): QueueStep {
  if (q.items.length === 0 || !target || target.optimistic) return { queue: q, action: null };
  if (target.status === "streaming") {
    return { queue: { ...q, follow: { kind: "node", nodeId: target.id }, paused: false }, action: null };
  }
  return shift(q, target.id);
}

/** 自动发出的那条没落地（服务端没回 `created`）：放回队首并暂停，不丢字。 */
export function requeueFailed(q: ComposerQueue, item: QueuedMessage, targetId: string): ComposerQueue {
  if (q.items.some((i) => i.id === item.id)) return q;
  return { items: [item, ...q.items], follow: { kind: "node", nodeId: targetId }, paused: true };
}

export function editQueued(q: ComposerQueue, id: string, text: string): ComposerQueue {
  const trimmed = text.trim();
  if (!trimmed) return q;
  return { ...q, items: q.items.map((i) => (i.id === id ? { ...i, text: trimmed } : i)) };
}

/** 取消一条：返回被移除的那条（调用方把文字与附件退回输入框）。 */
export function removeQueued(q: ComposerQueue, id: string): { queue: ComposerQueue; removed: QueuedMessage | null } {
  const removed = q.items.find((i) => i.id === id) ?? null;
  if (!removed) return { queue: q, removed: null };
  const items = q.items.filter((i) => i.id !== id);
  return { queue: items.length ? { ...q, items } : EMPTY_QUEUE, removed };
}

/**
 * 排队条的展示态：
 *   - empty   没有排队
 *   - auto    会自动发（目标在跑，或刚发出一条、在等新节点）
 *   - paused  上一轮出错 / 被停止
 *   - waiting 目标空闲但不是队列在等的那个节点（刷新后落到别的分支等）——同样给「继续发送」
 */
export type QueueStatus = "empty" | "auto" | "paused" | "waiting";

export function queueStatus(q: ComposerQueue, target: QueueTarget | null): QueueStatus {
  if (q.items.length === 0) return "empty";
  if (q.paused) return "paused";
  if (!target) return "waiting";
  if (target.status === "streaming" || q.follow?.kind === "childOf") return "auto";
  if (q.follow?.kind === "node" && q.follow.nodeId === target.id && target.status === "done") return "auto";
  return "waiting";
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";

function parseAttachment(raw: unknown): NodeAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (!isStr(a.hash) || !/^[0-9a-f]{64}$/.test(a.hash) || !isStr(a.mime) || typeof a.size !== "number") return null;
  return {
    hash: a.hash,
    mime: a.mime,
    size: a.size,
    filename: isStr(a.filename) ? a.filename : null,
    ...(typeof a.width === "number" ? { width: a.width } : {}),
    ...(typeof a.height === "number" ? { height: a.height } : {}),
  };
}

/** 读回 localStorage 里的队列；任何形状不对的部分都丢掉而不是抛错。 */
export function parseQueue(raw: string | null): ComposerQueue {
  if (!raw) return EMPTY_QUEUE;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_QUEUE;
  }
  if (!data || typeof data !== "object") return EMPTY_QUEUE;
  const d = data as Record<string, unknown>;
  const items: QueuedMessage[] = [];
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    if (!isStr(i.id) || !isStr(i.text) || !i.text.trim()) continue;
    items.push({
      id: i.id,
      text: i.text,
      attachments: (Array.isArray(i.attachments) ? i.attachments : [])
        .map(parseAttachment)
        .filter((a): a is NodeAttachment => !!a),
      createdAt: typeof i.createdAt === "number" ? i.createdAt : 0,
    });
  }
  if (items.length === 0) return EMPTY_QUEUE;
  const f = d.follow as Record<string, unknown> | null | undefined;
  const follow: QueueFollow =
    f?.kind === "node" && isStr(f.nodeId)
      ? { kind: "node", nodeId: f.nodeId }
      : f?.kind === "childOf" && (isStr(f.parentId) || f.parentId === null)
        ? { kind: "childOf", parentId: f.parentId as string | null }
        : null;
  return { items, follow, paused: d.paused === true };
}

export function serializeQueue(q: ComposerQueue): string | null {
  return q.items.length ? JSON.stringify(q) : null;
}
