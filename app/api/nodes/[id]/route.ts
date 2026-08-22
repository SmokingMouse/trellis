import { deleteNodeSubtree, getNode, setNodeTopicLabel } from "@/lib/server/repo";
import {
  buildToolTree,
  countToolTree,
  subagentLabel,
  walkToolTree,
} from "@/lib/tool-tree";
import { toolTitle } from "@/lib/tool-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单节点读取（trellisctl 平台操作面用）。此前只能整会话 GET /api/sessions/[id]
// 或挂 SSE 读 catchup，两者都拿不到「裸 nodeId → 元数据」的直达路径。
// 载荷纪律与 sessions/[id] 一致：剥完整 toolCalls（大会话里占 98%），
// 发 toolCallStats；完整数组走 GET /api/nodes/[id]/tool-calls。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "not_found" }, { status: 404 });
  const tree = buildToolTree(node.toolCalls);
  const counts = countToolTree(tree);
  const labels = walkToolTree(tree)
    .filter((t) => t.kind === "subagent")
    .map((t) => subagentLabel(t.meta));
  const tools = [...new Set(tree.map((t) => toolTitle(t.call)))].slice(0, 5);
  return Response.json({
    node: {
      ...node,
      toolCalls: undefined,
      toolCallStats: {
        total: counts.total,
        subagents: counts.subagents,
        workflows: counts.workflows,
        errors: counts.errors,
        labels,
        tools,
      },
    },
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const { topicLabel } = body as { topicLabel?: unknown };
  if (typeof topicLabel === "string") {
    const trimmed = topicLabel.trim();
    if (!trimmed) {
      return Response.json({ error: "empty_topic_label" }, { status: 400 });
    }
    const node = getNode(id);
    if (!node) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    setNodeTopicLabel(id, trimmed);
    return Response.json({ ok: true, topicLabel: trimmed });
  }

  return Response.json({ error: "no_supported_fields" }, { status: 400 });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const result = deleteNodeSubtree(id);
  if (!result.ok) {
    const status =
      result.reason === "not_found"
        ? 404
        : result.reason === "is_session_root"
          ? 409
          : 409;
    return Response.json({ error: result.reason }, { status });
  }
  return Response.json({
    deletedNodeIds: result.deletedNodeIds,
    deletedNoteIds: result.deletedNoteIds,
  });
}
