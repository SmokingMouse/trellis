import { mergeClaudeCommands } from "@/lib/claude-commands";
import { listClaudeCommandsCached } from "@/lib/server/claude-commands";

// Herdr 输入框的斜杠补全数据：内置常用命令 + 用户 / 项目的 skills 与 commands。
// 只做发现；选中后文本原样发进窗格，由 Claude Code 执行。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const workspace = new URL(request.url).searchParams.get("workspace");
  return Response.json({
    commands: mergeClaudeCommands(listClaudeCommandsCached(workspace)),
  });
}
