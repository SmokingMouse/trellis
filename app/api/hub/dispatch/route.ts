import "server-only";
import { MACHINE_NAME_RE, parseDispatchInput } from "@/lib/hub-dispatch";
import { relayToHub } from "@/lib/server/hub-relay-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/hub/dispatch {machine, prompt, workspace?, provider?} → hub /__gw/relay/dispatch
// `trellisctl dispatch`：把一件事派到同一用户名下的另一台机器上新开会话执行。
// 本地先按同一份规则校验一遍（省一趟网络、错误更早），策略由 hub 判。
// 日志不记 prompt 原文。
export async function POST(req: Request) {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const machine = typeof raw?.machine === "string" ? raw.machine.trim() : "";
  if (!MACHINE_NAME_RE.test(machine)) {
    return Response.json({ error: "要目标机器名（trellisctl machines 看有哪些）" }, { status: 400 });
  }
  const input = parseDispatchInput(raw);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const res = await relayToHub("POST", "/__gw/relay/dispatch", { machine, ...input });
  console.log(`[trellis/hub] dispatch → ${machine} prompt=${input.prompt.length}字 → ${res.status}`);
  return res;
}
