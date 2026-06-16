import { cliResumeForNode } from "@/lib/server/cli-fork";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单引号转义，让带空格/特殊字符的 cwd 在 shell 里安全。
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// GET /api/nodes/[id]/cli-resume —— 「在 CLI 继续」入口（progress/cli-branch-alignment.md）。
// project 模式会话本就是真 claude CLI 会话；返回可直接粘的续聊命令。不可续（非 project /
// 源 jsonl 已不在盘 / 无 resume id）→ resumable:false。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const r = cliResumeForNode(id);
  if (!r) {
    return Response.json({ resumable: false });
  }
  const command = `cd ${shellQuote(r.cwd)} && claude --resume ${r.resumeId}`;
  return Response.json({
    resumable: true,
    cwd: r.cwd,
    resumeId: r.resumeId,
    command,
  });
}
