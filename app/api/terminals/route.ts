import {
  listTerminals,
  nextTerminalSession,
  killTerminal,
} from "@/lib/server/terminals";
import { startTtyd, ttydStatus } from "@/lib/server/ttyd";
import { getDB } from "@/lib/server/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S1 P1：工作区终端。
//
// GET    /api/terminals?workspaceId=… → { ready, error, cwd, terminals[] }
// POST   /api/terminals  {workspaceId} → 分配下一个 session 名（不建，ttyd 连上时 tmux 自己建）
// DELETE /api/terminals?session=…      → kill-session
//
// **不返回 ttyd 端口**：前端 iframe 走同源的 `/term/…`，由大门（server.ts 的
// Bun.serve）转发。端口是大门自己通过 /api/terminals/port 问的内部细节，
// 不该出现在客户端能看到的响应里。`ready` 只回答「终端能不能用」。

function workspacePath(workspaceId: string): string | null {
  const row = getDB()
    .prepare("SELECT path FROM workspaces WHERE id = ?")
    .get(workspaceId) as { path: string } | undefined;
  return row?.path ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) {
    return Response.json({ error: "workspaceId required" }, { status: 400 });
  }
  const cwd = workspacePath(workspaceId);
  if (!cwd) {
    return Response.json({ error: "workspace not found" }, { status: 404 });
  }
  // 懒启动：第一次有人真要终端时才拉起 ttyd，纯 chat 用户永远不会多一个进程。
  await startTtyd();
  const { port, error, errorDetail } = ttydStatus();
  return Response.json({
    ready: port !== null,
    error,
    // 排查证据（探了哪些路径、各自为什么不行）。它只描述本机依赖的探测过程，
    // 不含凭证或会话数据，所以可以照直给到界面 —— 「未找到 ttyd」这句话
    // 单独出现时分不清是真没装还是探测抖了一下，那才是真正的坑。
    errorDetail,
    cwd,
    terminals: listTerminals(workspaceId),
  });
}

export async function POST(req: Request) {
  let body: { workspaceId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const workspaceId = body.workspaceId;
  if (!workspaceId) {
    return Response.json({ error: "workspaceId required" }, { status: 400 });
  }
  const cwd = workspacePath(workspaceId);
  if (!cwd) {
    return Response.json({ error: "workspace not found" }, { status: 404 });
  }
  await startTtyd();
  const { port, error, errorDetail } = ttydStatus();
  return Response.json({
    ready: port !== null,
    error,
    errorDetail,
    cwd,
    session: nextTerminalSession(workspaceId),
  });
}

export async function DELETE(req: Request) {
  const session = new URL(req.url).searchParams.get("session");
  if (!session) {
    return Response.json({ error: "session required" }, { status: 400 });
  }
  // killTerminal 内部有 `ws-` 前缀闸，防止把用户自己的 tmux session 杀掉。
  const ok = killTerminal(session);
  return Response.json({ ok });
}
