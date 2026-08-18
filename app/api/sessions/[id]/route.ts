import {
  getSession,
  getSessionNodes,
  deleteSession,
  renameSession,
  setSessionArchived,
  setSessionModel,
  listNotesBySession,
} from "@/lib/server/repo";
import { isProviderId } from "@/lib/llm";
import {
  buildToolTree,
  countToolTree,
  subagentLabel,
  walkToolTree,
} from "@/lib/tool-tree";
import { toolTitle } from "@/lib/tool-registry";
import { generatedFilesFromToolCalls } from "@/lib/generated-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  const nodes = getSessionNodes(id);
  const notes = listNotesBySession(id);
  // 大会话里 toolCalls 能占载荷 98%（实测 10.26MB 里 10.12MB），而首屏只有
  // 卡片角标和动线折叠态需要几个数字。这里剥离完整数组，改发预计算的
  // toolCallStats + generatedFiles；完整数组按需走 GET /api/nodes/[id]/tool-calls。
  // 流式节点不受影响（toolCalls 随流事件进客户端 store）。
  const slimNodes = nodes.map((n) => {
    const tree = buildToolTree(n.toolCalls);
    const counts = countToolTree(tree);
    const labels = walkToolTree(tree)
      .filter((t) => t.kind === "subagent")
      .map((t) => subagentLabel(t.meta));
    // 顶层工具名去重，喂给折叠摘要行（无委派时点名 "Bash、Read、Edit"）。
    // 截 5 个：客户端只显示前 4 个 + "…"，多给一个是为了让它判断有 "更多"。
    const tools = [...new Set(tree.map((t) => toolTitle(t.call)))].slice(0, 5);
    return {
      ...n,
      // toolCalls 占载荷 98%（实测 10.12MB / 10.26MB），不下发——
      // JSON.stringify 会丢弃 undefined 字段。客户端按需走
      // GET /api/nodes/[id]/tool-calls。
      toolCalls: undefined,
      toolCallStats: {
        total: counts.total,
        subagents: counts.subagents,
        workflows: counts.workflows,
        errors: counts.errors,
        labels,
        tools,
      },
      generatedFiles: generatedFilesFromToolCalls(n.toolCalls),
    };
  });
  return Response.json({ session, nodes: slimNodes, notes });
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
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;

  // Archive toggle (B2): { archived: boolean }. Mutually exclusive with the
  // rename path below — a single PATCH carries one intent.
  if ("archived" in obj) {
    if (typeof obj.archived !== "boolean") {
      return Response.json(
        { error: "expected { archived: boolean }" },
        { status: 400 },
      );
    }
    const session = setSessionArchived(id, obj.archived, Date.now());
    if (!session) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ session });
  }

  // Per-session model lock: { model: ProviderId }. Persists the session's own
  // model so switching away and back restores it instead of inheriting the
  // global picker. Validated against the ProviderId allowlist.
  if ("model" in obj) {
    if (!isProviderId(obj.model)) {
      return Response.json(
        { error: "expected { model: ProviderId }" },
        { status: 400 },
      );
    }
    const session = setSessionModel(id, obj.model);
    if (!session) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ session });
  }

  const title = obj.title;
  if (typeof title !== "string") {
    return Response.json(
      { error: "expected { title: string } or { archived: boolean }" },
      { status: 400 },
    );
  }
  if (!title.trim()) {
    return Response.json({ error: "title cannot be empty" }, { status: 400 });
  }
  const session = renameSession(id, title, Date.now());
  if (!session) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ session });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  deleteSession(id);
  return Response.json({ ok: true });
}
