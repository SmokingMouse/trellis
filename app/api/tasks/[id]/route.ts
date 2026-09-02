import {
  LarkTaskBindingError,
  getTask,
  updateTask,
  deleteTask,
  listTriggers,
  type TaskInput,
} from "@/lib/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ task, triggers: listTriggers(id) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  let task;
  try {
    task = updateTask(id, (body ?? {}) as Partial<TaskInput>);
  } catch (error) {
    if (error instanceof LarkTaskBindingError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ task });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!deleteTask(id)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
