import { installTtyd } from "@/lib/server/ttyd-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let installing = false;

export async function POST() {
  if (installing) {
    return Response.json(
      {
        ok: false,
        path: null,
        tried: [],
        error: "已有安装任务正在进行中",
      },
      { status: 409 },
    );
  }

  installing = true;
  try {
    const result = await installTtyd();
    return Response.json(
      {
        ok: result.ok,
        path: result.path,
        tried: result.tried,
        error: result.error ?? null,
      },
      { status: result.ok ? 200 : 500 },
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : "安装过程发生未知异常";
    return Response.json(
      {
        ok: false,
        path: null,
        tried: [],
        error,
      },
      { status: 500 },
    );
  } finally {
    installing = false;
  }
}
