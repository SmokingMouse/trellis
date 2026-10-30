import "server-only";
import { relayToHub } from "@/lib/server/hub-relay-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hub/machines → hub /__gw/relay/machines
// `trellisctl machines`：同一用户名下有哪些机器、在不在线、能不能派活（策略开关）。
export async function GET() {
  return relayToHub("GET", "/__gw/relay/machines");
}
