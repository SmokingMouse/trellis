// 会话接力 · 导入：POST /api/import/session
// body: { file: RelayFile, from?: <来源机器名>, workspacePath?: <本机绝对路径> }
// → 201 { sessionId, leafNodeId, path, title, mode }
// 核心逻辑在 lib/server/session-relay.ts:importRelaySession（跨机派活等可直接调），这里只管
// 请求体大小闸 + JSON 解析 + 错误映射。
import { RELAY_LIMITS } from "@/lib/session-relay";
import { importRelaySession, RelayError } from "@/lib/server/session-relay";
import { DbWriteError } from "@/lib/server/db-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 外层包装（from / workspacePath / JSON 键名）留一点余量。
const MAX_BODY = RELAY_LIMITS.maxBytes + 64 * 1024;

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return Response.json({ error: "接力数据超过大小上限" }, { status: 413 });
  }
  let text: string;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY) {
      return Response.json({ error: "接力数据超过大小上限" }, { status: 413 });
    }
    text = new TextDecoder().decode(buf);
  } catch {
    return Response.json({ error: "读取请求体失败" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "expected { file, from?, workspacePath? }" }, { status: 400 });
  }
  const { file, from, workspacePath } = body as Record<string, unknown>;
  if (from !== undefined && from !== null && typeof from !== "string") {
    return Response.json({ error: "from 必须是字符串" }, { status: 400 });
  }
  if (workspacePath !== undefined && workspacePath !== null && typeof workspacePath !== "string") {
    return Response.json({ error: "workspacePath 必须是字符串" }, { status: 400 });
  }
  try {
    const result = importRelaySession(file, {
      from: from || null,
      workspacePath: workspacePath || null,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RelayError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof DbWriteError) {
      return Response.json(
        { error: err.userMessage, code: err.code ?? err.kind },
        { status: err.kind === "full" ? 507 : 500 },
      );
    }
    console.error("[trellis/relay] 导入失败：", err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
