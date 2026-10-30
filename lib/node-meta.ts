// 节点附带的结构化标记（nodes.meta_json ↔ ApiNode / ChatNode 的 meta），前后端共用。
// docs/roles-p2.md 共享约定：值永远是一个带 kind 字符串的对象，NULL = 普通问答。
//
// kind 分两类：
//   · 系统节点（SYSTEM_NODE_KINDS）：会话里「不是模型回复」的已完成节点 —— 夜间整理卡、
//     跟进报告、群聊轮次结束。服务端写入见 lib/server/system-node.ts（appendSystemNode）。
//     它是会话里的一个新根，**不参与 claude resume**：输入框的落点、resume 的起点都跳过它，
//     chat 路由拒绝在它下面 branch / retry，不进全文搜索。
//   · 普通节点上的标记：群聊的 group-user / group-reply（作者、引用、轮次，见 lib/groups.ts）。
//     它们是真实的对话内容，**不是**系统节点。
// 判断是不是系统节点一律走 isSystemNode / isSystemNodeKind，不要拿「meta 非空」当系统节点。

export const SYSTEM_NODE_KINDS = ["role-nightly", "role-follow", "group-round-end"] as const;
export type SystemNodeKind = (typeof SYSTEM_NODE_KINDS)[number];

/** nodes.meta_json 解析后的形状：kind 必有，其余字段由各 kind 自定。 */
export type NodeMeta = { kind: string } & Record<string, unknown>;
export type SystemNodeMeta = { kind: SystemNodeKind } & Record<string, unknown>;

const SYSTEM_NODE_KINDS_SQL = `(${SYSTEM_NODE_KINDS.map((k) => `'${k}'`).join(", ")})`;

/** SQL 片段：`col`（nodes.meta_json 列表达式）不是系统节点。NULL / 坏 JSON / 群聊标记都算「不是」。 */
export function notSystemNodeSql(col: string): string {
  return `COALESCE(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.kind') END, '') NOT IN ${SYSTEM_NODE_KINDS_SQL}`;
}

export function isSystemNodeKind(v: unknown): v is SystemNodeKind {
  return typeof v === "string" && (SYSTEM_NODE_KINDS as readonly string[]).includes(v);
}

/** 宽进严出：坏 JSON / 不是对象 / 没有字符串 kind 一律当普通节点（null）。 */
export function parseNodeMeta(raw: string | null | undefined): NodeMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return typeof (v as { kind?: unknown }).kind === "string" ? (v as NodeMeta) : null;
  } catch {
    return null;
  }
}

export function isSystemNode(node: { meta?: NodeMeta | null } | null | undefined): boolean {
  return isSystemNodeKind(node?.meta?.kind);
}

/** 系统节点的 meta（收窄类型）；不是系统节点 = null。 */
export function systemNodeMeta(node: { meta?: NodeMeta | null } | null | undefined): SystemNodeMeta | null {
  const meta = node?.meta;
  return meta && isSystemNodeKind(meta.kind) ? (meta as SystemNodeMeta) : null;
}
