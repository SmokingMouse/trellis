/**
 * IM 入口层的策略内核（S134，spec: progress/im-entry-layer.md）。
 *
 * 纯函数、IM 无关、无 server-only：飞书 handler 把事件归一成 ImInbound 后调这里，
 * 拿到「这条消息是不是对机器人说的」和「这一轮落在画布哪里」。将来第二个 IM
 * （Telegram / 企微）只需提供自己的归一化与三个查表回调，策略零改动。
 *
 * 三个查表回调都由调用方注入，这里不碰 DB —— 所以 scripts/test-lark-bot.ts 能用
 * 内存 Map 把落点矩阵全组合跑一遍。
 */
import type { LarkBotPolicy } from "@/lib/lark-types";

export type ImChatType = "p2p" | "group";

export type ImInbound = {
  chatType: ImChatType;
  /** 已剥掉 bot mention token 的正文。 */
  text: string;
  /** 消息是否 @ 到了机器人本身（群聊才有意义）。 */
  mentionedBot: boolean;
  /** 飞书话题 id；消息在话题内才有。 */
  threadId: string | null;
  /** 回复链根消息 id。 */
  rootId: string | null;
  /** 被引用（回复）的那条消息 id。 */
  parentId: string | null;
};

export type ImPolicy = LarkBotPolicy;

export type ImLookups = {
  /** 某条 IM 消息（机器人发的或用户发的）对应的画布节点；不认识返回 null。 */
  nodeOfMessage: (messageId: string) => string | null;
  /** 某个话题当前的树叶子；话题没登记过返回 null。 */
  threadTail: (threadId: string) => string | null;
  /** 该 chat 线性链的链尾；还没聊过返回 null。 */
  chatTail: () => string | null;
};

export type ImAddressReason =
  | "p2p"
  | "quote"
  | "thread"
  | "mention"
  | "prefix"
  | "all"
  | "not_addressed";

export type ImAddress = { addressed: boolean; reason: ImAddressReason; text: string };

export type ImTarget =
  | { kind: "branch"; parentId: string; via: "quote" | "thread" | "chain" }
  | { kind: "root"; via: "thread" | "chat" };

/**
 * 「真引用」= 引用了回复链里某条具体消息，而不是话题内平铺发言（那种 parent_id 与
 * root_id 相同，都指向话题根）。区分这个才能让「话题内追问接叶子、引用某条回答分支」
 * 两种手势并存。
 */
function genuineQuoteTarget(inbound: ImInbound, lookups: ImLookups): string | null {
  if (!inbound.parentId || inbound.parentId === inbound.rootId) return null;
  return lookups.nodeOfMessage(inbound.parentId);
}

/** 对话的自然延续：不管触发档位，这些消息都算对机器人说的。 */
function continuationTarget(
  inbound: ImInbound,
  lookups: ImLookups,
): ImTarget | null {
  const quoted = genuineQuoteTarget(inbound, lookups);
  if (quoted) return { kind: "branch", parentId: quoted, via: "quote" };
  if (inbound.threadId) {
    const tail = lookups.threadTail(inbound.threadId);
    if (tail) return { kind: "branch", parentId: tail, via: "thread" };
  }
  if (inbound.rootId) {
    const root = lookups.nodeOfMessage(inbound.rootId);
    if (root) return { kind: "branch", parentId: root, via: "thread" };
  }
  if (inbound.parentId) {
    const parent = lookups.nodeOfMessage(inbound.parentId);
    if (parent) return { kind: "branch", parentId: parent, via: "quote" };
  }
  return null;
}

export function resolveAddress(
  inbound: ImInbound,
  policy: ImPolicy,
  lookups: ImLookups,
): ImAddress {
  const text = inbound.text.trim();
  if (inbound.chatType === "p2p") return { addressed: true, reason: "p2p", text };
  const continuation = continuationTarget(inbound, lookups);
  if (continuation && continuation.kind === "branch") {
    return { addressed: true, reason: continuation.via === "quote" ? "quote" : "thread", text };
  }
  switch (policy.groupTrigger) {
    case "all":
      return { addressed: true, reason: "all", text };
    case "prefix": {
      const prefix = policy.triggerPrefix?.trim();
      if (prefix && text.startsWith(prefix)) {
        return { addressed: true, reason: "prefix", text: text.slice(prefix.length).trim() };
      }
      // 前缀档下显式 @ 仍然算：用户点名了，不该被忽略。
      if (inbound.mentionedBot) return { addressed: true, reason: "mention", text };
      return { addressed: false, reason: "not_addressed", text };
    }
    default:
      return inbound.mentionedBot
        ? { addressed: true, reason: "mention", text }
        : { addressed: false, reason: "not_addressed", text };
  }
}

/** 落点解析。前置条件：resolveAddress 已判定 addressed。 */
export function resolveTarget(
  inbound: ImInbound,
  policy: ImPolicy,
  lookups: ImLookups,
): ImTarget {
  const continuation = continuationTarget(inbound, lookups);
  if (continuation) return continuation;
  if (inbound.chatType === "group" && policy.sessionPolicy === "thread") {
    return { kind: "root", via: "thread" };
  }
  const tail = lookups.chatTail();
  return tail ? { kind: "branch", parentId: tail, via: "chain" } : { kind: "root", via: "chat" };
}

const AGENT_SLUG_RE = /(^|\s)@([a-z0-9][a-z0-9-]{1,40})(?=$|\s|[，,。.!！?？:：;；])/i;

/**
 * 消息里的 `@slug` 单轮外援。与画布 @agent 同语义（折叠历史、不 resume、不落盘）。
 * 只认已知 slug —— `@某人` 之类的普通文本不会被误吃。
 */
export function extractAgentSlug(
  text: string,
  isKnownSlug: (slug: string) => boolean,
): { slug: string | null; text: string } {
  const match = AGENT_SLUG_RE.exec(text);
  if (!match) return { slug: null, text };
  const slug = match[2].toLowerCase();
  if (!isKnownSlug(slug)) return { slug: null, text };
  const stripped = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { slug, text: stripped || text };
}
