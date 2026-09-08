import { cliResumeForNode } from "@/lib/server/cli-fork";
import { getNode } from "@/lib/server/repo";
import { hasAliveHerdrBinding } from "@/lib/server/herdr-bindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单引号转义，让带空格/特殊字符的 cwd 在 shell 里安全。
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// GET /api/nodes/[id]/cli-resume —— 「在 CLI 继续」入口（progress/cli-branch-alignment.md）。
// project 模式会话本就是真 CLI 会话（claude jsonl / codex rollout）；返回可直接粘的
// 续聊命令。不可续（非 project / 源 transcript 已不在盘 / 无 resume id）→ resumable:false。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const node = getNode(id);
  // This route is callable without the UI. Check the live driver before
  // resolving a transcript or constructing any resume command.
  if (node && hasAliveHerdrBinding(node.sessionId)) {
    return Response.json({ resumable: false, error: "Session is driven by Herdr" }, { status: 409 });
  }
  const r = cliResumeForNode(id);
  if (!r) {
    return Response.json({ resumable: false });
  }
  // codex resume 的交互 picker 默认不列 exec 产生的 session，但带显式 id 直开；
  // cwd 由 session 自身恢复，cd 只是保险。
  const command =
    r.family === "codex"
      ? `cd ${shellQuote(r.cwd)} && codex resume ${r.resumeId}`
      : `cd ${shellQuote(r.cwd)} && claude --resume ${r.resumeId}`;
  return Response.json({
    resumable: true,
    cwd: r.cwd,
    resumeId: r.resumeId,
    command,
  });
}
