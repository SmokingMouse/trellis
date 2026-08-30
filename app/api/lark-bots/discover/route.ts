import { getDiscoveredLarkBots } from "@/lib/server/lark/discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const discovered = await getDiscoveredLarkBots();
    return Response.json({ discovered });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
