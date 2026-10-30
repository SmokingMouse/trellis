// 系统节点的标记（前后端共用）。系统节点 = 会话里「不是模型回复」的已完成节点：
// 跟进报告、夜间整理卡、群聊轮次结束。服务端写入见 lib/server/system-node.ts，
// 存在 nodes.meta_json；前端靠 meta.kind 换渲染（卡片而不是普通问答）。
//
// 系统节点是会话里的一个新根，**不参与 claude resume**：输入框的落点、resume 的
// 起点都要跳过它（isSystemNode）。

export const SYSTEM_NODE_KINDS = ["role-nightly", "role-follow", "group-round-end"] as const;
export type SystemNodeKind = (typeof SYSTEM_NODE_KINDS)[number];

export type SystemNodeMeta = { kind: SystemNodeKind } & Record<string, unknown>;

export function parseSystemNodeMeta(raw: string | null | undefined): SystemNodeMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const kind = (v as { kind?: unknown }).kind;
    return typeof kind === "string" && (SYSTEM_NODE_KINDS as readonly string[]).includes(kind)
      ? (v as SystemNodeMeta)
      : null;
  } catch {
    return null;
  }
}

export function isSystemNode(node: { meta?: SystemNodeMeta | null } | null | undefined): boolean {
  return !!node?.meta;
}
