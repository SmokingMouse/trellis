// 管家 = agent 固定为内置「Trellis 管家」的普通会话（不另造一套聊天链路）。
// 这里只放前后端都能 import 的常量与判定。id 与 seedBuiltinAgents 的
// `builtin-${slug}` 规则一致，见 lib/agent-presets.ts 的 trellis-admin 种子。
export const BUTLER_AGENT_ID = "builtin-trellis-admin";

export function isButlerSession(
  session: { agentId?: string | null } | null | undefined,
): boolean {
  return session?.agentId === BUTLER_AGENT_ID;
}

// GET /api/butler/overview 的形状 —— 管家右栏与 `trellisctl overview` 共用。
// 每节独立：某一节读挂了只让那一节带 error，不拖垮整张总览。
export type ButlerSection<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ButlerOverview = {
  agents: ButlerSection<{ total: number; disabled: number; custom: number }>;
  tasks: ButlerSection<{
    total: number;
    enabled: number;
    scheduled: number;
    running: number;
    failing: { id: string; name: string; status: string; error: string | null }[];
  }>;
  models: ButlerSection<{
    defaultModel: string | null;
    providers: number;
    missingKey: string[];
  }>;
  auth: ButlerSection<{
    clis: {
      name: "claude" | "codex";
      installed: boolean;
      loggedIn: boolean | null;
      refreshExpiresAt: number | null;
      warnings: string[];
      errors: string[];
    }[];
  }>;
  bots: ButlerSection<{
    total: number;
    enabled: number;
    errored: { id: string; name: string; error: string }[];
  }>;
  version: ButlerSection<{
    sha: string | null;
    builtAt: string | null;
    behind: number | null;
    deployPhase: string | null;
  }>;
  generatedAt: number;
};

// ── 改动提案（第 2 步）────────────────────────────────────────────────────
// 管家会话里 trellisctl 的配置写请求 = 一条提案；用户在卡片上确认才落库。
export type ButlerChangeKind =
  | "agent.create" | "agent.update" | "agent.delete"
  | "task.create" | "task.update" | "task.delete"
  | "trigger.add" | "trigger.remove";

export type ButlerChangeStatus = "pending" | "applied" | "rejected" | "failed" | "reverted";

export type ButlerChange = {
  id: string;
  sessionId: string;
  nodeId: string | null;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  kind: ButlerChangeKind;
  targetId: string | null;
  /** 人读的对象名：agent 名 / 任务名 / 「任务名 · cron 触发器」 */
  targetLabel: string;
  /** high = 不可撤销（删除 agent / 任务），卡片要输入对象名二次确认 */
  risk: "normal" | "high";
  status: ButlerChangeStatus;
  /** 目标对象改之前的样子（提案时取一次，应用那一刻再刷新成真快照）；create 为 null */
  before: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
  revertedAt: number | null;
  /** 已应用且能构造出逆请求 */
  revertible: boolean;
};

export const CHANGE_KIND_LABEL: Record<ButlerChangeKind, string> = {
  "agent.create": "新建 Agent",
  "agent.update": "修改 Agent",
  "agent.delete": "删除 Agent",
  "task.create": "新建定时任务",
  "task.update": "修改定时任务",
  "task.delete": "删除定时任务",
  "trigger.add": "添加触发器",
  "trigger.remove": "移除触发器",
};

/** 高危确认口令：要求用户输入的名字（去掉「任务名 · xxx」这类后缀修饰）。 */
export function confirmPhrase(c: Pick<ButlerChange, "targetLabel">): string {
  return c.targetLabel.split(" · ")[0];
}
