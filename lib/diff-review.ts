// diff 审阅的纯逻辑：行内评论的片段截取 / 整理成发给 agent 的消息、「仅上一轮」
// 的改动文件集合。UI 在 components/WorkspaceDiffModal.tsx。
import type { ChatNode, ToolCall } from "./types";
import { generatedFilesFromToolCalls } from "./generated-files";
import type { DiffHunk, DiffLine } from "./unified-diff";

export type ReviewComment = {
  id: string;
  /** 仓库根相对路径 */
  path: string;
  /** new = 新版本行号（新增 / 上下文行）；old = 旧版本行号（删除行） */
  side: "new" | "old";
  line: number;
  /** 带 +/-/空格 前缀的 diff 片段（被评论行及其前几行） */
  snippet: string;
  body: string;
  createdAt: number;
};

export function diffLinePrefix(kind: DiffLine["kind"]): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : kind === "ctx" ? " " : "";
}

/** 评论锚点：删除行用旧行号，其余用新行号。meta 行不可评论。 */
export function commentAnchor(line: DiffLine): { side: "new" | "old"; line: number } | null {
  if (line.kind === "meta") return null;
  if (line.kind === "del") return line.oldNo === null ? null : { side: "old", line: line.oldNo };
  return line.newNo === null ? null : { side: "new", line: line.newNo };
}

/** 截取被评论行及其前 `context` 行（同一 hunk 内，跳过 meta 行）作为 diff 片段。 */
export function snippetAt(hunk: DiffHunk, index: number, context = 2): string {
  const out: string[] = [];
  for (let i = Math.max(0, index - context); i <= index && i < hunk.lines.length; i++) {
    const l = hunk.lines[i];
    if (l.kind === "meta") continue;
    out.push(diffLinePrefix(l.kind) + l.text);
  }
  return out.join("\n");
}

export function commentLocation(c: Pick<ReviewComment, "path" | "line" | "side">): string {
  return c.side === "old" ? `${c.path}:${c.line}（已删除的旧行）` : `${c.path}:${c.line}`;
}

// 片段里可能本身就有 ``` —— 围栏取比正文里最长的反引号串多一个。
function fenceFor(body: string): string {
  let max = 0;
  for (const m of body.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

export function sortComments(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.createdAt - b.createdAt,
  );
}

/**
 * 把评论草稿整理成一条发给 agent 的消息：每条 `path:line — 评论`，附该行 diff 片段。
 * 放进输入框草稿，由用户确认后自己发送。
 */
export function formatReviewMessage(comments: ReviewComment[]): string {
  const list = sortComments(comments).filter((c) => c.body.trim());
  if (list.length === 0) return "";
  const parts = [`请根据下面的代码审阅评论修改（共 ${list.length} 条）：`];
  list.forEach((c, i) => {
    const body = c.body.trim().replace(/\n+/g, "\n   ");
    let block = `${i + 1}. ${commentLocation(c)} — ${body}`;
    if (c.snippet) {
      const fence = fenceFor(c.snippet);
      block += `\n${fence}diff\n${c.snippet}\n${fence}`;
    }
    parts.push(block);
  });
  return parts.join("\n\n");
}

// Codex（AS 引擎）的 fileChange 被映射成 name="Edit"、input={ changes }，没有
// file_path；changes 可能是 [{ path }] 数组或 { [path]: … } 对象，两种都认。
function codexChangePaths(tc: ToolCall): string[] {
  if (tc.name !== "Edit") return [];
  const input = tc.input as { changes?: unknown } | null;
  const changes = input && typeof input === "object" ? input.changes : undefined;
  if (Array.isArray(changes)) {
    return changes
      .map((c) => (c && typeof c === "object" ? (c as { path?: unknown }).path : undefined))
      .filter((p): p is string => typeof p === "string" && p.startsWith("/"));
  }
  if (changes && typeof changes === "object") {
    return Object.keys(changes).filter((p) => p.startsWith("/"));
  }
  return [];
}

/** 一轮里写 / 改过的文件绝对路径（去重，首见顺序）。 */
export function turnChangedPaths(node: Pick<ChatNode, "toolCalls" | "generatedFiles">): string[] {
  const seen = new Set<string>();
  if (node.toolCalls.length > 0) {
    for (const f of generatedFilesFromToolCalls(node.toolCalls)) seen.add(f.absPath);
    for (const tc of node.toolCalls) for (const p of codexChangePaths(tc)) seen.add(p);
  } else {
    for (const f of node.generatedFiles ?? []) seen.add(f.absPath);
  }
  return [...seen];
}

/** 最近一轮有文件改动的节点（按 createdAt）。 */
export function lastChangedTurn<N extends Pick<ChatNode, "id" | "createdAt" | "toolCalls" | "generatedFiles">>(
  nodes: Record<string, N> | N[],
): { node: N; paths: string[] } | null {
  const list = Array.isArray(nodes) ? nodes : Object.values(nodes);
  let best: { node: N; paths: string[] } | null = null;
  for (const n of list) {
    if (best && n.createdAt <= best.node.createdAt) continue;
    const paths = turnChangedPaths(n);
    if (paths.length > 0) best = { node: n, paths };
  }
  return best;
}

/** 绝对路径 → 仓库根相对路径；不在仓库内返回 null。 */
export function toRepoRelative(absPath: string, root: string): string | null {
  const r = root.replace(/\/+$/, "");
  if (!absPath.startsWith(r + "/")) return null;
  return absPath.slice(r.length + 1);
}
