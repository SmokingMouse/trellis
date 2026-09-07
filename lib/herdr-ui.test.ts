import { describe, expect, test } from "bun:test";
import {
  buildHerdrWorkspaceViews,
  findHerdrPaneForSession,
  type HerdrFleetResponse,
  type HerdrHookRecord,
} from "./herdr-ui";

const fleet: HerdrFleetResponse = {
  available: true,
  enabled: true,
  realtime: true,
  readOnly: false,
  protocol: 19,
  version: "test",
  lastError: null,
  workspaces: [
    {
      workspace_id: "w1",
      label: "Trellis",
      tabs: [
        {
          tab_id: "t1",
          panes: [
            {
              pane_id: "p-working",
              terminal_id: "term-1",
              focused: false,
              agent: "codex",
              agent_status: "working",
              cwd: "/repo",
              label: "builder",
              terminal_title: null,
              revision: 1,
            },
            {
              pane_id: "p-waiting",
              terminal_id: "term-2",
              focused: true,
              agent: "claude",
              agent_status: "working",
              cwd: "/repo",
              label: "reviewer",
              terminal_title: null,
              revision: 2,
            },
          ],
        },
      ],
    },
  ],
  sessions: [
    {
      sessionId: "codex-session",
      agentKind: "codex",
      paneId: "p-working",
      terminalId: "term-1",
      workspaceId: "w1",
      tabId: "t1",
      label: "builder",
      agentName: null,
      cwd: "/repo",
      transcriptPath: "/tmp/codex.jsonl",
      agentStatus: "working",
      revision: 1,
      alive: true,
    },
    {
      sessionId: "claude-session",
      agentKind: "claude",
      paneId: "p-waiting",
      terminalId: "term-2",
      workspaceId: "w1",
      tabId: "t1",
      label: "reviewer",
      agentName: "reviewer",
      cwd: "/repo",
      transcriptPath: "/tmp/claude.jsonl",
      agentStatus: "working",
      revision: 2,
      alive: true,
    },
  ],
};

describe("Herdr UI fleet projection", () => {
  test("overlays hook state and puts waiting panes first", () => {
    const hooks: HerdrHookRecord[] = [
      {
        sessionId: "claude-session",
        agent: "claude",
        state: "waiting",
        toolName: "AskUserQuestion",
        interactivePrompt: { questions: [] },
        paneKey: "p-waiting",
        updatedAt: 10,
      },
    ];
    const workspaces = buildHerdrWorkspaceViews(fleet, hooks);
    expect(workspaces[0].panes.map((pane) => pane.paneId)).toEqual([
      "p-waiting",
      "p-working",
    ]);
    expect(workspaces[0].panes[0].status).toBe("waiting");
    expect(findHerdrPaneForSession(workspaces, "codex-session")?.paneId).toBe(
      "p-working",
    );
  });
});
