import { rejectHookRequest } from "@/lib/server/agent-hooks/auth";
import { pollInteraction } from "@/lib/server/agent-hooks/interactions";
import { notifyConsoleChange } from "@/lib/server/console-events";
import type { ClaudeHookPayload } from "@/lib/server/agent-hooks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 脚本没给 wait 时的段长。 */
const DEFAULT_WAIT_S = 25;

function reply(line: string, body = ""): Response {
  // 纯文本给 sh 解析：首行是结论，余下（只有 done 有）是原样打到 stdout 的 hook JSON。
  return new Response(body ? `${line}\n${body}\n` : `${line}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * POST /api/hooks/claude/interaction —— 阻塞 hook（`trellis-hook.sh --block`）的长轮询。
 * 只有 trellis 拉起的 claude 会打到这里（见 agent-hooks/blocking-settings.ts）。
 *
 * 表单体（同 /api/hooks/claude，curl --data-urlencode）：
 *   payload  hook 的原始 JSON；每段都带，trellis 重启后靠它重建 / 认领交互
 *   paneKey  发起的 herdr pane
 *   attempt  hook 进程的随机 id（没有 tool_use_id 时参与交互 id，见 interactionId）
 *   wait     本段最多挂几秒（脚本每段 25）
 *
 * 应答首行：
 *   pending  还没人答，脚本接着下一段
 *   done     下一行起是 hook stdout JSON
 *   pass     不阻塞 / 交给终端 / 过期 / 已撤销：脚本无输出退出，TUI 照常弹框
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
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v !== "" ? v : null;
  };
  const waitS = Number(field("wait") ?? DEFAULT_WAIT_S);
  const waitMs = Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : DEFAULT_WAIT_S * 1000;
  const attempt = field("attempt");

  const result = await pollInteraction(payload, field("paneKey"), waitMs, {
    signal: req.signal,
    attempt: attempt && attempt.length <= 128 ? attempt : null,
    onChange: () => notifyConsoleChange("hook"),
  });
  if (result.status === "done") return reply("done", JSON.stringify(result.output));
  if (result.status === "pass") return reply("pass", "");
  return reply("pending");
}
