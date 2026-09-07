import { createHash, timingSafeEqual } from "node:crypto";
import { readHookToken } from "@/lib/server/agent-hooks/endpoint";
import { recordClaudeHook } from "@/lib/server/agent-hooks/store";
import type { ClaudeHookPayload } from "@/lib/server/agent-hooks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const HOOK_TOKEN_HEADER = "x-trellis-hook-token";

/**
 * 常量时间比对。先各自 sha256 再比 —— 直接比字符串会按长度早退，
 * 而 timingSafeEqual 要求等长（长度不同会抛，本身也是一次泄漏）。
 */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * POST /api/hooks/claude —— Claude Code hook 的落点。
 *
 * 表单体（脚本用 curl --data-urlencode 发）：
 *   paneKey  发起的 herdr pane，可为空
 *   payload  hook 的原始 JSON 字符串
 *
 * 这条路由挂在 Claude 的每次工具调用前后，必须**快**且**永不 5xx 拖时间**：
 * 脚本那边 --max-time 1.5 会兜底，但我们自己也别慢。
 */
export async function POST(req: Request) {
  const expected = readHookToken();
  if (!expected) {
    // 端点文件还没写（TRELLIS_HOOKS=off 或启动钩子失败）= 这个口没开。
    return Response.json({ error: "hooks not enabled" }, { status: 503 });
  }
  const given = req.headers.get(HOOK_TOKEN_HEADER) ?? "";
  if (!given || !tokenMatches(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid form body" }, { status: 400 });
  }
  const raw = form.get("payload");
  if (typeof raw !== "string" || raw === "") {
    return Response.json({ error: "missing payload" }, { status: 400 });
  }
  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeHookPayload;
  } catch {
    return Response.json({ error: "invalid payload json" }, { status: 400 });
  }
  const paneKeyField = form.get("paneKey");
  const paneKey = typeof paneKeyField === "string" ? paneKeyField : null;

  const record = recordClaudeHook(payload, { paneKey });
  if (!record) {
    // 没有 session_id 就没法归属。不是错误（有些事件确实不带），静默认账。
    return Response.json({ ok: true, ignored: "no session_id" });
  }
  return Response.json({ ok: true, sessionId: record.sessionId, state: record.state });
}
