// 阻塞 hook 交互的前后端共用类型 + 前端作答动作。
// 服务端逻辑在 lib/server/agent-hooks/interaction-core.ts / interactions.ts。

export type BlockingKind = "question" | "permission" | "plan";

/** 计划审批放行后切到哪种权限模式。 */
export type PlanMode = "bypassPermissions" | "acceptEdits";

/** 作答体（POST /api/herdr/interactions/:id 的 answer）。 */
export type InteractionResolution =
  | { type: "answers"; answers: Record<string, string> }
  | { type: "permission"; allow: true; always?: boolean }
  | { type: "permission"; allow: false; message?: string }
  | { type: "plan"; approve: true; mode: PlanMode }
  | { type: "plan"; approve: false; feedback?: string };

/** 某会话此刻挂着的阻塞交互（HookSummary.blocking）。 */
export type BlockingSummary = {
  id: string;
  kind: BlockingKind;
  toolName: string;
  toolUseId: string | null;
  /** AskUserQuestion 的题目（tool_input.questions 原样） */
  questions?: unknown[];
  /** PermissionRequest 的一句话说明（命令 / 文件路径…） */
  summary?: string;
  /** ExitPlanMode 的计划 Markdown */
  plan?: string;
  /** PermissionRequest：能否给「本会话总是允许」 */
  canAlways?: boolean;
  createdAt: number;
  /**
   * pending  还在等人答；
   * resolved 刚在 Trellis 上答过（10 分钟内）。hook 已经放行，但观测 hook 的 waiting 要等
   *          PostToolUse 才收起 —— 这段时间卡片显示「已作答」，不能退回发按键路径。
   */
  status: "pending" | "resolved";
  /** hook 此刻是否挂在长轮询上（false = 断线重连窗口内） */
  connected: boolean;
};

export class BlockingAnswerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function post(id: string, body: unknown): Promise<{ connected: boolean }> {
  const res = await fetch(`/api/herdr/interactions/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; connected?: boolean };
  if (!res.ok) throw new BlockingAnswerError(data.error || `HTTP ${res.status}`, res.status);
  return { connected: data.connected !== false };
}

export function answerBlockingInteraction(id: string, answer: InteractionResolution): Promise<{ connected: boolean }> {
  return post(id, { action: "answer", answer });
}

/** 交给终端：hook 无输出退出，电脑上的 TUI 照常弹框。 */
export function handoffBlockingInteraction(id: string): Promise<{ connected: boolean }> {
  return post(id, { action: "handoff" });
}
