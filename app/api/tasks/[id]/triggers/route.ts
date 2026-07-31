import {
  createTrigger,
  deleteTrigger,
  getTask,
  listTriggers,
  refreshFsWatches,
  type TriggerKind,
} from "@/lib/server/tasks";
import { parseCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: TriggerKind[] = ["cron", "fs", "git", "session_done", "lark"];

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return Response.json({ triggers: listTriggers(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const kind = o.kind as TriggerKind;
  if (!KINDS.includes(kind)) {
    return Response.json({ error: `kind must be one of ${KINDS.join("|")}` }, { status: 400 });
  }
  const config = (o.config ?? {}) as Record<string, unknown>;
  // cron 串在**入口**就校验：一个写错的表达式静默不触发，几周后才会被发现。
  if (kind === "cron" && !parseCron(String(config.expr ?? ""))) {
    return Response.json({ error: `cron 表达式无效：${config.expr}` }, { status: 400 });
  }
  // ★ 防自触发（第二道，第一道在 onNodeSettled 里）：任务监听自己的任务会话
  // 就是一个无限循环烧钱的闭环。
  if (kind === "session_done") {
    const task = getTask(id);
    if (!task) return Response.json({ error: "task not found" }, { status: 404 });
    if (String(config.sessionId ?? "") === task.homeSessionId) {
      return Response.json(
        { error: "不能监听这个任务自己的会话 —— 那是一个无限触发的闭环" },
        { status: 400 },
      );
    }
  }
  const t = createTrigger(id, kind, config);
  if (!t) return Response.json({ error: "task not found" }, { status: 404 });
  // fs 触发器立刻生效，不用等下一次 tick。
  if (kind === "fs") refreshFsWatches();
  return Response.json({ trigger: t }, { status: 201 });
}

export async function DELETE(req: Request) {
  const triggerId = new URL(req.url).searchParams.get("triggerId");
  if (!triggerId) return Response.json({ error: "missing triggerId" }, { status: 400 });
  const ok = deleteTrigger(triggerId);
  refreshFsWatches();
  return Response.json({ ok });
}
