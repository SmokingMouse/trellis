import { describe, expect, test } from "bun:test";
import {
  buildHerdrConsole,
  cleanTerminalTitle,
  diffHerdrAttention,
  findConsolePaneForSession,
  groupHerdrLanes,
  herdrAttentionText,
  herdrStatusLabel,
  herdrStripPanes,
  HERDR_ATTENTION_FLICKER_MS,
  matchHerdrPanes,
  nextNeedPane,
  shellTitle,
  stepHerdrPane,
  tabLabelOf,
  type HerdrConsolePane,
} from "./herdr-console";
import { buildHerdrWorkspaceViews, type HerdrFleetPane, type HerdrFleetResponse, type HerdrHookRecord, type HerdrSessionBinding } from "./herdr-ui";

const NOW = 1_800_000_000_000;

function pane(id: string, agent: string | null, status: string, title: string | null, extra: Partial<HerdrFleetPane> = {}): HerdrFleetPane {
  return { pane_id: id, terminal_id: `term-${id}`, focused: false, agent, agent_status: status, cwd: "/repo", label: null, terminal_title: title, revision: 1, ...extra };
}

function binding(sessionId: string, paneId: string, alive = true, extra: Partial<HerdrSessionBinding> = {}): HerdrSessionBinding {
  return {
    sessionId, agentKind: "claude", paneId, terminalId: `term-${paneId}`, workspaceId: paneId.split(":")[0], tabId: `${paneId.split(":")[0]}:t1`,
    label: null, agentName: null, cwd: "/Users/x/code/harbor", transcriptPath: null, agentStatus: "idle", revision: 1, alive, ...extra,
  };
}

const fleet: HerdrFleetResponse = {
  available: true, enabled: true, realtime: true, readOnly: false, protocol: 19, version: "t", lastError: null,
  inputDeliveries: [
    { inputId: "i1", paneId: "w4:p1", status: "queued" },
    { inputId: "i2", paneId: "w4:p1", status: "delivered" },
  ],
  workspaces: [
    { workspace_id: "w3", label: "harbor", tabs: [
      { tab_id: "w3:t1", label: "1", panes: [pane("w3:p1", null, "unknown", "me@host:~/harbor")] },
      { tab_id: "w3:t2", label: "2", panes: [pane("w3:p2", "claude", "blocked", "✳ Harbor 价值与迭代方向")] },
    ] },
    { workspace_id: "w4", label: "trellis", tabs: [
      { tab_id: "w4:t1", label: "1", panes: [pane("w4:p1", "claude", "working", "⠂ Agent workflow 交互展示优化", { agent_session: { value: "s-new" } })] },
    ] },
    { workspace_id: "w6", label: "fisher", tabs: [
      { tab_id: "w6:t1", label: "1", panes: [pane("w6:p1", "claude", "working", "✻ 闲鱼开源项目调研")] },
    ] },
    { workspace_id: "w5", label: "trader", tabs: [
      { tab_id: "w5:t1", label: "1", panes: [pane("w5:p1", "claude", "idle", "策略层优化空间")] },
      { tab_id: "w5:t2", label: "review", panes: [pane("w5:p2", "codex", "done", null, { label: "reviewer" })] },
    ] },
  ],
  sessions: [
    binding("s-harbor", "w3:p2", true, { trellisSessionId: "trellis-harbor" }),
    binding("s-new", "w4:p1"),
    binding("s-fisher", "w6:p1"),
    binding("s-trader", "w5:p1"),
    binding("s-old", "w4:p1"),
    binding("s-dead", "w2X:p1", false, { label: "Leader role-play", lastSeenAt: NOW - 3 * 86_400_000 }),
    binding("s-dead", "w2X:p1", false),
  ],
};

const hooks: HerdrHookRecord[] = [
  { sessionId: "s-harbor", state: "waiting", toolName: "Bash", interactivePrompt: { approval: { tool: "Bash", summary: "git push origin main\n推送 3 个提交" } }, paneKey: null, updatedAt: NOW - 4 * 60_000 },
  { sessionId: "s-new", state: "working", toolName: "Edit", interactivePrompt: null, paneKey: null, updatedAt: NOW - 30_000 },
  { sessionId: "s-trader", state: "done", toolName: null, interactivePrompt: null, paneKey: null, updatedAt: NOW - 60_000 },
];

const panes = buildHerdrConsole(fleet, hooks, NOW);
const byKey = (key: string) => panes.find((p) => p.key === key)!;

describe("buildHerdrConsole", () => {
  test("lanes: blocked/waiting → need, working → run, idle/done → idle, shell & offline separate", () => {
    expect(byKey("w3:p2").lane).toBe("need");
    expect(byKey("w4:p1").lane).toBe("run");
    expect(byKey("w5:p1").lane).toBe("idle");
    expect(byKey("w5:p2").lane).toBe("idle");
    expect(byKey("w3:p1").lane).toBe("shell");
    expect(byKey("off:s-dead").lane).toBe("off");
    expect(panes.filter((p) => p.lane === "off")).toHaveLength(1);
  });

  test("titles strip spinner glyphs; shells keep the path; tabs read t<n>", () => {
    expect(byKey("w3:p2").title).toBe("Harbor 价值与迭代方向");
    expect(byKey("w4:p1").title).toBe("Agent workflow 交互展示优化");
    expect(byKey("w3:p1").title).toBe("~/harbor");
    expect(byKey("w5:p2").title).toBe("reviewer");
    expect(byKey("w3:p2").tabLabel).toBe("t2");
    expect(byKey("w5:p2").tabLabel).toBe("review");
    expect(byKey("off:s-dead").title).toBe("Leader role-play");
  });

  test("session binding prefers herdr's reported agent session, trellis id wins for navigation", () => {
    expect(byKey("w4:p1").sessionId).toBe("s-new");
    expect(byKey("w3:p2").sessionId).toBe("trellis-harbor");
    expect(byKey("w3:p1").sessionId).toBeNull();
    expect(findConsolePaneForSession(panes, "trellis-harbor")?.key).toBe("w3:p2");
    expect(findConsolePaneForSession(panes, "s-harbor")?.key).toBe("w3:p2");
  });

  test("queued count, last tool and activity come from deliveries and hooks", () => {
    expect(byKey("w4:p1").queued).toBe(1);
    expect(byKey("w4:p1").lastTool).toBe("Edit");
    expect(byKey("w3:p2").activityAt).toBe(NOW - 4 * 60_000);
  });

  test("unavailable fleet yields nothing", () => {
    expect(buildHerdrConsole(null, [], NOW)).toEqual([]);
  });
});

describe("ordering", () => {
  test("strip: need → run → idle; idle by recent activity; shell/offline excluded", () => {
    const strip = herdrStripPanes(panes);
    expect(strip.map((p) => p.key)).toEqual(["w3:p2", "w6:p1", "w4:p1", "w5:p1", "w5:p2"]);
  });

  test("lanes keep need oldest-first and idle newest-first", () => {
    const extra: HerdrConsolePane[] = [
      { ...byKey("w3:p2"), key: "a", activityAt: NOW - 1000 },
      { ...byKey("w3:p2"), key: "b", activityAt: NOW - 9000 },
      { ...byKey("w5:p1"), key: "c", activityAt: null },
      { ...byKey("w5:p1"), key: "d", activityAt: NOW },
    ];
    const lanes = groupHerdrLanes(extra);
    expect(lanes.need.map((p) => p.key)).toEqual(["b", "a"]);
    expect(lanes.idle.map((p) => p.key)).toEqual(["d", "c"]);
  });

  test("next need wraps after current and skips it; step does not wrap", () => {
    const strip = herdrStripPanes(panes);
    expect(nextNeedPane(strip, "w4:p1")?.key).toBe("w3:p2");
    expect(nextNeedPane(strip, "w3:p2")).toBeNull();
    expect(nextNeedPane(strip, null)?.key).toBe("w3:p2");
    expect(stepHerdrPane(strip, "w3:p2", -1)).toBeNull();
    expect(stepHerdrPane(strip, "w3:p2", 1)?.key).toBe("w6:p1");
    expect(stepHerdrPane(strip, null, -1)?.key).toBe("w5:p2");
  });

  test("palette matching is multi-term over workspace / tab / title", () => {
    expect(matchHerdrPanes(panes, "harbor").map((p) => p.key)).toEqual(["w3:p2", "off:s-dead", "w3:p1"]);
    expect(matchHerdrPanes(panes, "trader review").map((p) => p.key)).toEqual(["w5:p2"]);
    expect(matchHerdrPanes(panes, "")[0].key).toBe("w3:p2");
  });
});

describe("attention notifications", () => {
  test("first snapshot seeds state without notifying", () => {
    const { raised } = diffHerdrAttention(null, panes, NOW);
    expect(raised).toEqual([]);
  });

  test("a pane turning need raises exactly once per episode", () => {
    const calm = panes.map((p) => (p.key === "w6:p1" ? p : p));
    let { state } = diffHerdrAttention(null, calm, NOW);
    const stuck = panes.map((p) => (p.key === "w6:p1" ? { ...p, lane: "need" as const } : p));
    const first = diffHerdrAttention(state, stuck, NOW + 1000);
    expect(first.raised.map((p) => p.key)).toEqual(["w6:p1"]);
    state = first.state;
    const again = diffHerdrAttention(state, stuck, NOW + 2000);
    expect(again.raised).toEqual([]);
  });

  test("brief flicker out of need is the same episode; a later block is a new one", () => {
    const stuck = panes.map((p) => (p.key === "w6:p1" ? { ...p, lane: "need" as const } : p));
    let { state } = diffHerdrAttention(null, stuck, NOW);
    state = diffHerdrAttention(state, panes, NOW + 1000).state; // 抖回 run
    const flicker = diffHerdrAttention(state, stuck, NOW + 2000);
    expect(flicker.raised).toEqual([]);
    state = diffHerdrAttention(flicker.state, panes, NOW + 3000).state;
    state = diffHerdrAttention(state, panes, NOW + 3000 + HERDR_ATTENTION_FLICKER_MS).state;
    const later = diffHerdrAttention(state, stuck, NOW + 4000 + HERDR_ATTENTION_FLICKER_MS);
    expect(later.raised.map((p) => p.key)).toEqual(["w6:p1"]);
  });

  test("attention text reads the hook prompt", () => {
    expect(herdrAttentionText(byKey("w3:p2"))).toBe("要执行 Bash：git push origin main");
    const ask = { ...byKey("w3:p2"), view: { ...byKey("w3:p2").view!, hook: { ...hooks[0], interactivePrompt: { questions: [{ question: "要往哪个方向深挖？" }] } } } };
    expect(herdrAttentionText(ask)).toBe("提问：要往哪个方向深挖？");
    expect(herdrAttentionText({ ...byKey("w3:p2"), view: null, lastTool: null })).toBe("终端在等你输入");
  });
});

describe("helpers", () => {
  test("title cleanup", () => {
    expect(cleanTerminalTitle("✳ 任务")).toBe("任务");
    expect(cleanTerminalTitle("⠐ 任务 ✳")).toBe("任务 ✳");
    expect(cleanTerminalTitle(null)).toBe("");
    expect(shellTitle("me@mac-mini:~", null)).toBe("~");
    expect(shellTitle(null, "/tmp")).toBe("/tmp");
    expect(tabLabelOf({ tab_id: "w1:t9" })).toBe("t9");
  });

  test("workspace views pick the binding herdr reports as current", () => {
    const views = buildHerdrWorkspaceViews(fleet, [], NOW);
    const trellis = views.find((w) => w.id === "w4")!.panes[0];
    expect(trellis.binding?.sessionId).toBe("s-new");
  });
});

test("status labels read Chinese like the lanes, never raw idle/blocked/unknown", () => {
  expect(herdrStatusLabel("working")).toBe("在跑");
  expect(herdrStatusLabel("blocked")).toBe("需要你");
  expect(herdrStatusLabel("waiting")).toBe("需要你");
  expect(herdrStatusLabel("idle")).toBe("空闲");
  expect(herdrStatusLabel("done")).toBe("空闲");
  expect(herdrStatusLabel("unknown")).toBe("空闲");
  expect(herdrStatusLabel("working", false)).toBe("已离线");
});
