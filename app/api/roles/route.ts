import {
  createRole,
  listRoles,
  parseRoleInput,
  readJsonBody,
  roleErrorResponse,
} from "@/lib/server/roles";

// 角色 P1（docs/roles-p1.md）：列表与新建。单个角色走 ./[id]。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ roles: listRoles() });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const input = parseRoleInput(await readJsonBody(req), false);
    return Response.json({ role: createRole(input) }, { status: 201 });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
