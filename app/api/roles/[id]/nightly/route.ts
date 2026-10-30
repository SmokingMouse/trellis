import { readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { getNightlyState, runRoleNightly, setNightlyFrequency } from "@/lib/server/role-nightly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** → RoleNightlyState */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return Response.json(getNightlyState(id));
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** body { frequency: 'daily' | 'weekly' | 'off' } → RoleNightlyState */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = (await readJsonBody(req)) as { frequency?: unknown } | null;
    return Response.json(setNightlyFrequency(id, body?.frequency));
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** 立即整理一次（同调度那条路径：没新对话照样跳过、不调模型）。会等模型跑完（几十秒）。
 * → { result: NightlyRunResult, state: RoleNightlyState } */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const result = await runRoleNightly(id);
    return Response.json({ result, state: getNightlyState(id) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
