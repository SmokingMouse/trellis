import { listTasks, createTask, listTriggers, listRuns, type TaskInput } from "@/lib/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 列表一次带齐 triggers + 最近一条 run —— 任务页要展示「下次何时跑 / 上次结果」，
// 分三个请求拿只会让首屏闪三次。
export async function GET() {
  const tasks = listTasks();
  return Response.json({
    tasks: tasks.map((t) => ({
      ...t,
      triggers: listTriggers(t.id),
      lastRun: listRuns(t.id, 1)[0] ?? null,
    })),
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.prompt !== "string") {
    return Response.json({ error: "expected { name, prompt }" }, { status: 400 });
  }
  if (o.contextMode === "project" && !o.workspacePath) {
    return Response.json({ error: "project 模式必须给 workspacePath" }, { status: 400 });
  }
  return Response.json({ task: createTask(o as unknown as TaskInput) }, { status: 201 });
}
