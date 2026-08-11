import { collectMachineResources } from "@/lib/server/machine-resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await collectMachineResources(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[machine-resources] 采集失败：", error);
    return Response.json(
      { error: "机器资源采集失败" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
