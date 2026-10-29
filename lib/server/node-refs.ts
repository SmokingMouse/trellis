import "server-only";
import { getDB } from "./sqlite";
import { escapeLikePattern, getNode, getSession, searchAll } from "./repo";
import { sessionSourcePredicate, sidebarSessionKinds } from "../session-source";
import {
  buildNodeRefSuffix,
  parseNodeRefs,
  readableNodeRefs,
  type ParsedNodeRef,
  type ResolvedNodeRef,
} from "@/lib/node-refs";

// `@` 引用其他会话 / 节点（lib/node-refs.ts）的服务端部分：
//   - 候选：按最近活跃列会话，模糊匹配标题 / 节点 topic，并合并全文搜索命中；
//   - 展开：列某会话里可引用的已完成节点；
//   - 注入：从问题正文里解析引用 id，按 id 现取节点内容拼成上下文块。

/** 侧栏可见的会话来源才可被引用（内部 / 系统会话不出现在候选里，也不允许按 id 硬引）。 */
const VISIBLE_KINDS: ReadonlySet<string> = new Set(sidebarSessionKinds);

export type RefCandidateNode = {
  nodeId: string;
  index: number;
  question: string;
  topicLabel: string | null;
  createdAt: number;
};

export type RefCandidateSession = {
  sessionId: string;
  title: string;
  updatedAt: number;
  mode: string;
  /** 默认引用的节点：该会话最新一个已完成节点；没有就 null（不可选） */
  latest: RefCandidateNode | null;
};

type NodeLite = {
  id: string;
  question: string;
  topic_label: string | null;
  created_at: number;
};

function ordinal(sessionId: string, createdAt: number): number {
  const row = getDB()
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE session_id = ? AND created_at <= ?")
    .get(sessionId, createdAt) as { n: number };
  return row.n;
}

function toCandidateNode(sessionId: string, r: NodeLite): RefCandidateNode {
  return {
    nodeId: r.id,
    index: ordinal(sessionId, r.created_at),
    question: r.question.slice(0, 200),
    topicLabel: r.topic_label,
    createdAt: r.created_at,
  };
}

function latestDoneNode(sessionId: string): RefCandidateNode | null {
  const r = getDB()
    .prepare(
      `SELECT id, question, topic_label, created_at FROM nodes
       WHERE session_id = ? AND status = 'done'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as NodeLite | undefined;
  return r ? toCandidateNode(sessionId, r) : null;
}

type SessionLite = { id: string; title: string; updated_at: number; context_mode: string };

/** `@` 候选会话：空查询 = 最近活跃；有查询 = 标题 / topic 模糊匹配（每个词都要命中）+ 全文搜索补充。 */
export function listRefCandidates(rawQuery: string, limit = 20): RefCandidateSession[] {
  const db = getDB();
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const where: string[] = ["archived = 0", sessionSourcePredicate()];
  const params: (string | number)[] = [];
  for (const t of terms) {
    const like = `%${escapeLikePattern(t)}%`;
    where.push(
      `(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM nodes n WHERE n.session_id = sessions.id AND n.topic_label LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT id, title, updated_at, context_mode FROM sessions
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as SessionLite[];

  // 标题 / topic 没命中但正文命中的会话（复用 ⌘P 的全文索引），排在后面。
  if (terms.length > 0 && rows.length < limit) {
    const seen = new Set(rows.map((r) => r.id));
    const extraIds = searchAll(rawQuery, 60)
      .map((g) => g.sessionId)
      .filter((id) => !seen.has(id));
    if (extraIds.length > 0) {
      const marks = extraIds.map(() => "?").join(",");
      const extra = db
        .prepare(
          `SELECT id, title, updated_at, context_mode FROM sessions
           WHERE id IN (${marks}) AND archived = 0 AND ${sessionSourcePredicate()}
           ORDER BY updated_at DESC`,
        )
        .all(...extraIds) as SessionLite[];
      rows.push(...extra.slice(0, limit - rows.length));
    }
  }

  return rows.map((r) => ({
    sessionId: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    mode: r.context_mode,
    latest: latestDoneNode(r.id),
  }));
}

/** 展开某会话：可引用的已完成节点，新的在前。会话不可见 / 不存在返回 null。 */
export function listRefNodes(sessionId: string, limit = 50): RefCandidateNode[] | null {
  const session = getSession(sessionId);
  if (!session || !VISIBLE_KINDS.has(session.kind ?? "user")) return null;
  const rows = getDB()
    .prepare(
      `SELECT id, question, topic_label, created_at FROM nodes
       WHERE session_id = ? AND status = 'done'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, limit) as NodeLite[];
  return rows.map((r) => toCandidateNode(sessionId, r));
}

/** 按 id 现取一个被引用节点；不存在 / 已删 / 会话不匹配 / 会话不可见一律 null。 */
export function resolveNodeRef(ref: ParsedNodeRef, currentNodeId?: string): ResolvedNodeRef | null {
  if (ref.nodeId === currentNodeId) return null;
  const node = getNode(ref.nodeId);
  if (!node || node.sessionId !== ref.sessionId) return null;
  const session = getSession(node.sessionId);
  if (!session || !VISIBLE_KINDS.has(session.kind ?? "user")) return null;
  const response = node.kind === "reference" ? (node.reference?.contentMd ?? node.response) : node.response;
  return {
    sessionId: node.sessionId,
    nodeId: node.id,
    sessionTitle: session.title,
    index: ordinal(node.sessionId, node.createdAt),
    topicLabel: node.topicLabel,
    question: node.question,
    response,
    statusNote:
      node.status === "streaming"
        ? "该节点引用时仍在生成，以下回答可能不完整"
        : node.status === "error"
          ? "该节点上次运行出错，以下回答可能不完整"
          : null,
  };
}

export type NodeRefContext = {
  /** 标记换成 `[@标题 #N]` 的可读问题（发给模型 / 起标题 / topic 用） */
  readable: string;
  /** 追加在本轮用户消息后的上下文块；无引用时为空串 */
  suffix: string;
  resolved: ResolvedNodeRef[];
  missing: ParsedNodeRef[];
};

/** chat 路由的注入入口：从（落库的）问题正文解析引用，按 id 现取内容组装上下文。 */
export function buildNodeRefContext(question: string, currentNodeId?: string): NodeRefContext {
  const { refs } = parseNodeRefs(question);
  if (refs.length === 0) return { readable: question, suffix: "", resolved: [], missing: [] };
  const resolved: ResolvedNodeRef[] = [];
  const missing: ParsedNodeRef[] = [];
  for (const ref of refs) {
    const r = resolveNodeRef(ref, currentNodeId);
    if (r) resolved.push(r);
    else missing.push(ref);
  }
  return {
    readable: readableNodeRefs(question),
    suffix: buildNodeRefSuffix(resolved, missing),
    resolved,
    missing,
  };
}
