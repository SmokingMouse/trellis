// Herdr 推送单测的 fleet 夹具：一个 workspace「trellis」、tab「review」、一个 claude 窗格 w1:p1，
// 绑定 Trellis 会话 trellis-s1。状态 / hook 由用例给，经 buildHerdrConsole 派生成窗格（与线上同一条路）。
import { buildHerdrConsole, type HerdrConsolePane } from "../herdr-console";
import type { HerdrFleetResponse, HerdrHookRecord } from "../herdr-ui";

export const PANE_ID = "w1:p1";
export const SESSION_ID = "trellis-s1";

export function herdrFleet(status: string, opts: { bound?: boolean; transcriptPath?: string | null } = {}): HerdrFleetResponse {
  const bound = opts.bound ?? true;
  return {
    available: true, enabled: true, realtime: true, readOnly: false, protocol: 19, version: "t", lastError: null,
    workspaces: [{
      workspace_id: "w1", label: "trellis", tabs: [{
        tab_id: "w1:t1", label: "review", panes: [{
          pane_id: PANE_ID, terminal_id: "term-1", focused: false, agent: "claude", agent_status: status,
          cwd: "/repo", label: null, terminal_title: "✳ 推送改造", revision: 1,
        }],
      }],
    }],
    sessions: bound
      ? [{
          sessionId: "cli-1", trellisSessionId: SESSION_ID, agentKind: "claude", paneId: PANE_ID, terminalId: "term-1",
          workspaceId: "w1", tabId: "w1:t1", label: null, agentName: null, cwd: "/repo",
          transcriptPath: opts.transcriptPath ?? null, agentStatus: status, revision: 1, alive: true,
        }]
      : [],
  };
}

export function approvalHook(toolUseId: string, summary: string, updatedAt: number): HerdrHookRecord {
  return {
    sessionId: "cli-1", state: "waiting", toolName: "Bash", paneKey: PANE_ID, updatedAt,
    interactivePrompt: { approval: { tool: "Bash", summary }, tool_name: "Bash", tool_use_id: toolUseId },
  };
}

export function askHook(toolUseId: string, question: string, updatedAt: number): HerdrHookRecord {
  return {
    sessionId: "cli-1", state: "waiting", toolName: "AskUserQuestion", paneKey: PANE_ID, updatedAt,
    interactivePrompt: { questions: [{ question, options: [{ label: "是" }] }], tool_name: "AskUserQuestion", tool_use_id: toolUseId },
  };
}

export function herdrPanes(status: string, hook: HerdrHookRecord | null, now: number, opts?: Parameters<typeof herdrFleet>[1]): HerdrConsolePane[] {
  return buildHerdrConsole(herdrFleet(status, opts), hook ? [hook] : [], now);
}
