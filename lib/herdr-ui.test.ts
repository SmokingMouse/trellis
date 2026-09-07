import { describe, expect, test } from "bun:test";
import {
  buildHerdrWorkspaceViews,
  findHerdrPaneForSession,
  HERDR_HOOK_TTL_MS,
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
  test("only fresh waiting hooks override live pane state, including fallback views", () => {
    const now = 1_000_000;
    const doneFleet = structuredClone(fleet);
    doneFleet.workspaces[0].tabs[0].panes[1].agent_status = "done";
    doneFleet.sessions[1].agentStatus = "done";
    for (const [state, age, expected] of [
      ["working", 0, "done"], ["done", 0, "done"],
      ["waiting", 0, "waiting"], ["waiting", HERDR_HOOK_TTL_MS + 1, "done"],
    ] as const) {
      const hooks: HerdrHookRecord[] = [{ sessionId: "claude-session", agent: "claude", state, toolName: null, interactivePrompt: {}, paneKey: "p-waiting", updatedAt: now - age }];
      const views = buildHerdrWorkspaceViews(doneFleet, hooks, now);
      expect(views[0].panes.find(p => p.paneId === "p-waiting")?.status).toBe(expected);
      expect(findHerdrPaneForSession(doneFleet, hooks, [], "claude-session", now)?.status).toBe(expected);
      if (age > HERDR_HOOK_TTL_MS) expect(views[0].panes.find(p => p.paneId === "p-waiting")?.hook).toBeNull();
    }
  });

  test("a reused pane cannot inherit the prior session's waiting hook", () => {
    const hooks: HerdrHookRecord[] = [{ sessionId: "old-session", agent: "claude", state: "waiting", toolName: null, interactivePrompt: {}, paneKey: "p-waiting", updatedAt: Date.now() }];
    const views = buildHerdrWorkspaceViews(fleet, hooks);
    expect(views[0].panes.find(p => p.paneId === "p-waiting")?.status).toBe("working");
  });

  test("overlays hook state and puts waiting panes first", () => {
    const hooks: HerdrHookRecord[] = [
      {
        sessionId: "claude-session",
        agent: "claude",
        state: "waiting",
        toolName: "AskUserQuestion",
        interactivePrompt: { questions: [] },
        paneKey: "p-waiting",
        updatedAt: Date.now(),
      },
    ];
    const workspaces = buildHerdrWorkspaceViews(fleet, hooks);
    expect(workspaces[0].panes.map((pane) => pane.paneId)).toEqual([
      "p-waiting",
      "p-working",
    ]);
    expect(workspaces[0].panes[0].status).toBe("waiting");
    expect(
      findHerdrPaneForSession(fleet, hooks, workspaces, "codex-session")?.paneId,
    ).toBe(
      "p-working",
    );
  });
});
