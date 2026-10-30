import {
  createGroup,
  groupErrorResponse,
  listGroups,
  parseGroupInput,
  readGroupJson,
} from "@/lib/server/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 群聊列表（未归档，最近活动降序）。设计见 docs/roles-p2.md B。 */
export async function GET() {
  try {
    return Response.json({ groups: listGroups() });
  } catch (e) {
    return groupErrorResponse(e);
  }
}

/** 建群：{ name, roleIds（2–6 位角色）, workDir?, provider? } → { group } */
export async function POST(req: Request) {
  try {
    const input = parseGroupInput(await readGroupJson(req));
    return Response.json({ group: createGroup(input) }, { status: 201 });
  } catch (e) {
    return groupErrorResponse(e);
  }
}
