import { describe, expect, test } from "bun:test";
import {
  buildHerdrSessionStatusMap,
  buildHerdrWorkspaceViews,
  groupHerdrWorkspaces,
  findHerdrPaneForSession,
  HERDR_HOOK_TTL_MS,
  type HerdrFleetResponse,
  type HerdrHookRecord,
} from "./herdr-ui";

test("侧栏 status map 仅索引已绑定会话，断线和关闭 pane 保留离线状态", () => {
  const online = buildHerdrSessionStatusMap(fleet, []);
  expect(online.size).toBe(fleet.sessions.length);
  const binding = fleet.sessions[0];
  const id = binding.trellisSessionId ?? binding.sessionId;
  expect(online.get(id)?.alive).toBe(true);
  expect(buildHerdrSessionStatusMap(fleet, [], "network failure").get(id)?.alive).toBe(false);
  expect(buildHerdrSessionStatusMap({ ...fleet, available: false }, []).get(id)?.alive).toBe(false);
  expect(buildHerdrSessionStatusMap({ ...fleet, workspaces: [] }, []).get(id)?.alive).toBe(false);
  expect(buildHerdrSessionStatusMap(null, []).size).toBe(0);
});

describe("Herdr repository tree", () => {
  test("P2-3 trailing slashes share checkout identity and never create empty labels", () => {
    const view = buildHerdrWorkspaceViews(fleet, [])[0];
    const tree = groupHerdrWorkspaces(["", "/", "///"].map((suffix, i) => ({ ...view, id: String(i), worktree: { repo_root: `/repo${suffix}`, repo_name: "Repo", checkout_path: `/missing${suffix}`, is_linked_worktree: true } })));
    expect(tree.repositories).toHaveLength(1);
    expect(tree.repositories[0].worktrees).toHaveLength(1);
    expect(tree.repositories[0].worktrees[0]).toMatchObject({ id: "/missing", label: "未知分支" });
    expect(tree.repositories[0].worktrees[0].panes).toHaveLength(6);
  });
  test("P2-1 missing and detached branches never claim main", () => {
    for (const git_branch of [undefined, null, "", "HEAD"]) {
      for (const is_linked_worktree of [true, false]) {
        const tree = groupHerdrWorkspaces([{ ...buildHerdrWorkspaceViews(fleet, [])[0], worktree: { repo_root: "/repo", repo_name: "Repo", checkout_path: "/repo", is_linked_worktree, git_branch } }]);
        expect(tree.repositories[0].worktrees[0].label).toBe("未知分支");
      }
    }
  });
  test("P1-1 shuffled repositories, checkouts and merged sessions stay stable across status changes", () => {
    const make = (id: string, root: string, checkout: string, linked: boolean) => ({
      ...structuredClone(fleet.workspaces[0]), workspace_id: id, label: id,
      worktree: { repo_root: root, repo_name: "Same name", checkout_path: checkout, is_linked_worktree: linked, git_branch: linked ? "a-feature" : "z-main" },
    });
    const input = { ...fleet, sessions: [], workspaces: [make("z", "/z", "/z", false), make("linked", "/a", "/a-linked", true), make("main", "/a", "/a", false), make("duplicate", "/a", "/a", false)] };
    input.workspaces.forEach((w, i) => w.tabs[0].panes.forEach(p => { p.pane_id += i; }));
    const shape = () => groupHerdrWorkspaces(buildHerdrWorkspaceViews(input, [])).repositories.map(r => [r.id, r.worktrees.map(w => [w.id, w.panes.map(p => p.paneId)])]);
    const before = shape();
    expect(before.map(r => r[0])).toEqual(["/a", "/z"]);
    const tree = groupHerdrWorkspaces(buildHerdrWorkspaceViews(input, []));
    expect(tree.repositories[0].worktrees.map(w => w.id)).toEqual(["/a", "/a-linked"]);
    expect(tree.repositories[0].worktrees[0].panes.map(p => p.label)).toEqual(["builder", "builder", "reviewer", "reviewer"]);
    input.workspaces.reverse().forEach(w => w.tabs[0].panes.reverse().forEach(p => { p.agent_status = p.label === "reviewer" ? "waiting" : "idle"; }));
    expect(shape()).toEqual(before);
    expect(groupHerdrWorkspaces(buildHerdrWorkspaceViews(input, [])).repositories[0].attention).toBe(3);
  });
  test("groups checkouts by canonical repository, bubbles attention and keeps non-git last", () => {
    const panes = buildHerdrWorkspaceViews(fleet, [])[0].panes;
    const worktree = { repo_root: "/repo", repo_name: "Repo", checkout_path: "/repo", is_linked_worktree: false };
    const tree = groupHerdrWorkspaces([
      { id: "scratch", label: "Scratch", panes: [panes[0]] },
      { id: "main", label: "Checkout", worktree, panes: [{ ...panes[0], status: "waiting" }] },
      { id: "linked", label: "Feature", worktree: { ...worktree, checkout_path: "/linked", is_linked_worktree: true, git_branch: "feat/nest" }, panes: [{ ...panes[1], status: "blocked" }] },
      { id: "duplicate", label: "Another tab", worktree, panes: [panes[1]] },
      { id: "other", label: "Other", worktree: { ...worktree, repo_name: "Z repo", repo_root: "/other", checkout_path: "/other" }, panes: [panes[0]] },
    ]);
    expect(tree.repositories).toHaveLength(2);
    expect(tree.repositories[0].attention).toBe(2);
    expect(tree.repositories[0].worktrees.map(w => [w.id, w.label, w.attention, w.panes.length])).toEqual([
      ["/repo", "未知分支", 1, 2], ["/linked", "feat/nest", 1, 1],
    ]);
    expect(tree.repositories[0].worktrees[0].title).toContain("Another tab");
    expect(tree.ungrouped.map(w => w.id)).toEqual(["scratch"]);
    expect(groupHerdrWorkspaces([])).toEqual({ repositories: [], ungrouped: [] });
  });
});

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

  test("P1-1 overlays hook state without moving waiting panes", () => {
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
      "p-working",
      "p-waiting",
    ]);
    expect(workspaces[0].panes[1].status).toBe("waiting");
    expect(
      findHerdrPaneForSession(fleet, hooks, workspaces, "codex-session")?.paneId,
    ).toBe(
      "p-working",
    );
  });
});
