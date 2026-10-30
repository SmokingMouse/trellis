import { rejectHookRequest } from "@/lib/server/agent-hooks/auth";
import { cancelInteractionsForEvent } from "@/lib/server/agent-hooks/interactions";
import { recordClaudeHook } from "@/lib/server/agent-hooks/store";
import { nudgeCliTranscript } from "@/lib/server/cli-sync-watcher";
import { notifyConsoleChange } from "@/lib/server/console-events";
import type { ClaudeHookPayload } from "@/lib/server/agent-hooks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { HOOK_TOKEN_HEADER } from "@/lib/server/agent-hooks/auth";

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
  const rejected = rejectHookRequest(req);
  if (rejected) return rejected;

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
  // 阻塞交互的收尾：这次工具调用已经往下走了 / 这一轮过去了（用户在电脑上 Esc 掉了挂着的
  // hook），还挂着的卡作废。只是一条按 session 走索引的 SELECT，不拖慢快路径。
  let cancelled = 0;
  try {
    cancelled = cancelInteractionsForEvent(payload);
  } catch {
    /* 收尾失败不影响应答 */
  }
  // 控制台推送：待答卡的收起 / 弹出靠这一下（合并窗口 100ms，无订阅者时零成本）。
  if (record || cancelled > 0) notifyConsoleChange("hook");
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
