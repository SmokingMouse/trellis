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
