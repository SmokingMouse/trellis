import { createHash, timingSafeEqual } from "node:crypto";
import { readHookToken } from "@/lib/server/agent-hooks/endpoint";
import { recordClaudeHook } from "@/lib/server/agent-hooks/store";
import { nudgeCliTranscript } from "@/lib/server/cli-sync-watcher";
import { notifyConsoleChange } from "@/lib/server/console-events";
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
  // 控制台推送：待答卡的收起 / 弹出靠这一下（合并窗口 100ms，无订阅者时零成本）。
  if (record) notifyConsoleChange("hook");
  // Hook 驱动同步：每个事件都意味着 transcript 刚追加过（或马上追加），让镜像立刻
  // 重导，而不是等 fs.watch 的 600ms 去抖。只对已镜像的文件生效；失败不影响应答。
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  let nudged = false;
  if (transcriptPath) {
    try {
      nudged = nudgeCliTranscript(transcriptPath);
    } catch {
      /* 同步是锦上添花，hook 应答必须快且稳 */
    }
  }
  if (!record) {
    // 没有 session_id 就没法归属。不是错误（有些事件确实不带），静默认账。
    return Response.json({ ok: true, ignored: "no session_id" });
  }
  // nudged：这次事件是否催动了镜像重导（排查「为什么没同步」时看这个）。
  return Response.json({ ok: true, sessionId: record.sessionId, state: record.state, nudged });
}
