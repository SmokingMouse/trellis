import { describe, expect, test } from "bun:test";
import { buildHerdrConsole } from "./herdr-console";
import {
  appModeFor,
  applyHerdrTitles,
  herdrPaneLabelMeta,
  herdrPaneTitle,
  buildHerdrModeGroups,
  herdrGroupName,
  herdrModeStrip,
  herdrRowTitle,
  herdrSendTarget,
  isDefaultTerminalTitle,
  parseAppMode,
  shortPath,
} from "./herdr-mode";
import type { HerdrFleetPane, HerdrFleetResponse, HerdrHookRecord, HerdrSessionBinding } from "./herdr-ui";

const NOW = 1_800_000_000_000;

function pane(id: string, agent: string | null, status: string, title: string | null, extra: Partial<HerdrFleetPane> = {}): HerdrFleetPane {
  return { pane_id: id, terminal_id: `term-${id}`, focused: false, agent, agent_status: status, cwd: "/Users/x/.claude", label: null, terminal_title: title, revision: 1, ...extra };
}

function binding(sessionId: string, paneId: string, extra: Partial<HerdrSessionBinding> = {}): HerdrSessionBinding {
  const ws = paneId.split(":")[0];
  return {
    sessionId, agentKind: "claude", paneId, terminalId: `term-${paneId}`, workspaceId: ws, tabId: `${ws}:t1`,
    label: null, agentName: null, cwd: null, transcriptPath: null, agentStatus: "idle", revision: 1, alive: true, ...extra,
  };
}

function fleetOf(workspaces: HerdrFleetResponse["workspaces"], sessions: HerdrSessionBinding[] = []): HerdrFleetResponse {
  return { available: true, enabled: true, realtime: true, readOnly: false, protocol: 19, version: "t", lastError: null, workspaces, sessions };
}

describe("模式判定", () => {
  test("parseAppMode 只认 herdr，其余回落对话", () => {
    expect(parseAppMode("herdr")).toBe("herdr");
    expect(parseAppMode("chat")).toBe("chat");
    expect(parseAppMode(null)).toBe("chat");
    expect(parseAppMode("garbage")).toBe("chat");
  });

  test("Herdr 会话 / 总览 → herdr；普通会话 / 首页 → chat", () => {
    expect(appModeFor({ session: { id: "a", origin: "herdr" }, herdrOpen: false })).toBe("herdr");
    expect(appModeFor({ session: { id: "a", origin: "web" }, herdrOpen: false })).toBe("chat");
    expect(appModeFor({ session: null, herdrOpen: true })).toBe("herdr");
    expect(appModeFor({ session: null, herdrOpen: false })).toBe("chat");
  });

  test("接入的 CLI 会话被活窗格绑定时也算 Herdr", () => {
    const fleet = fleetOf([], [binding("cli-1", "w1:p1")]);
    expect(appModeFor({ session: { id: "cli-1", origin: "cli-import" }, herdrOpen: false }, fleet)).toBe("herdr");
    const dead = fleetOf([], [binding("cli-1", "w1:p1", { alive: false })]);
    expect(appModeFor({ session: { id: "cli-1", origin: "cli-import" }, herdrOpen: false }, dead)).toBe("chat");
  });
});

describe("行标题派生", () => {
  test("终端标题 > 会话标题 > pane label（角色名）> cwd", () => {
    expect(herdrRowTitle({ label: "claude-leader", terminalTitle: "✳ 任务名", sessionTitle: "会话" })).toBe("任务名");
    expect(herdrRowTitle({ label: "claude-leader", terminalTitle: "✳ Claude Code", sessionTitle: "会话" })).toBe("会话");
    expect(herdrRowTitle({ label: "claude-leader", terminalTitle: "✳ Claude Code", cwd: "/r/app" })).toBe("claude-leader");
  });

  test("label 没被用作标题才作 meta", () => {
    expect(herdrPaneLabelMeta("leader", "重构")).toBe("leader");
    expect(herdrPaneLabelMeta("leader", "leader")).toBeNull();
    expect(herdrPaneLabelMeta(null, "x")).toBeNull();
  });

  test("终端标题去掉 spinner 前缀", () => {
    expect(herdrRowTitle({ terminalTitle: "◑ Agent workflow 交互展示优化" })).toBe("Agent workflow 交互展示优化");
    expect(herdrRowTitle({ terminalTitle: "✳ 策略层优化空间" })).toBe("策略层优化空间");
  });

  test("默认标题（Claude Code / agent 名 / shell 提示符）跳过，落到会话标题再落到 cwd", () => {
    expect(herdrRowTitle({ terminalTitle: "✳ Claude Code", sessionTitle: "评测设计", cwd: "/Users/x/.claude" })).toBe("评测设计");
    expect(herdrRowTitle({ terminalTitle: "✳ Claude Code", sessionTitle: "  ", cwd: "/Users/x/.claude" })).toBe(".claude");
    expect(herdrRowTitle({ terminalTitle: "codex", agentKind: "codex", cwd: "/r/app/" })).toBe("app");
    expect(herdrRowTitle({ terminalTitle: "me@host:~/repo", cwd: "/r/repo" })).toBe("repo");
  });

  test("isDefaultTerminalTitle", () => {
    expect(isDefaultTerminalTitle("Claude Code")).toBe(true);
    expect(isDefaultTerminalTitle("claude")).toBe(true);
    expect(isDefaultTerminalTitle("my-agent", "my-agent")).toBe(true);
    expect(isDefaultTerminalTitle("Claude Code 调研")).toBe(false);
  });

  test("shortPath", () => {
    expect(shortPath("/Users/x/.claude")).toBe("~/.claude");
    expect(shortPath("/Users/x/code/agent/harbor")).toBe("…/agent/harbor");
    expect(shortPath("/opt/app")).toBe("/opt/app");
  });
});

describe("分组与排序", () => {
  const hooks: HerdrHookRecord[] = [
    { sessionId: "s-run", state: "working", toolName: "Bash", interactivePrompt: null, paneKey: null, updatedAt: NOW - 1_000 },
  ];
  const fleet = fleetOf(
    [
      { workspace_id: "w1", label: ".claude", number: 7, tabs: [{ tab_id: "w1:t1", panes: [pane("w1:p1", "claude", "idle", "✳ Claude Code")] }] },
      {
        workspace_id: "w2", label: ".claude", number: 9, tabs: [
          { tab_id: "w2:t1", panes: [pane("w2:p1", "claude", "idle", "✳ 评测设计")] },
          { tab_id: "w2:t2", panes: [pane("w2:p2", null, "unknown", "me@host:~/.claude")] },
        ],
      },
      {
        workspace_id: "w3", label: "harbor", number: 1,
        worktree: { repo_root: "/r/harbor", repo_name: "harbor", checkout_path: "/r/harbor", is_linked_worktree: false, git_branch: "main" },
        tabs: [{ tab_id: "w3:t1", panes: [pane("w3:p1", "claude", "blocked", "✳ 价值与方向", { cwd: "/r/harbor" })] }],
      },
      {
        workspace_id: "w4", label: "trellis", number: 2,
        worktree: { repo_root: "/r/trellis", repo_name: "trellis", checkout_path: "/r/trellis-wt", is_linked_worktree: true, git_branch: "feat-x" },
        tabs: [{ tab_id: "w4:t1", panes: [pane("w4:p1", "claude", "working", "◐ 重构", { cwd: "/r/trellis-wt", label: "leader" })] }],
      },
      { workspace_id: "w5", label: "empty", number: 3, tabs: [{ tab_id: "w5:t1", panes: [] }] },
    ],
    [binding("s-claude", "w1:p1"), binding("s-eval", "w2:p1"), binding("s-need", "w3:p1"), binding("s-run", "w4:p1")],
  );
  const panes = buildHerdrConsole(fleet, hooks, NOW);
  const titles: Record<string, string> = { "s-claude": "修 skill 路由" };
  const groups = buildHerdrModeGroups(fleet, panes, (id) => titles[id]);

  test("组序：需要你 → 在跑 → 最近活动 → Herdr 编号；空工作区不出", () => {
    expect(groups.map((g) => g.id)).toEqual(["w3", "w4", "w1", "w2"]);
    expect(groups[0].need).toBe(1);
    expect(groups[1].run).toBe(1);
  });

  test("同名工作区附区分后缀（同一 cwd → 退到 #编号）", () => {
    const w1 = groups.find((g) => g.id === "w1")!;
    const w2 = groups.find((g) => g.id === "w2")!;
    expect(w1.hint).toBe("#7");
    expect(w2.hint).toBe("#9");
    expect(herdrGroupName(w1)).toBe(".claude #7");
    expect(groups.find((g) => g.id === "w3")!.hint).toBeNull();
  });

  test("分支：linked worktree 附分支，主 checkout 的 main 不附", () => {
    expect(groups.find((g) => g.id === "w4")!.branch).toBe("feat-x");
    expect(groups.find((g) => g.id === "w3")!.branch).toBeNull();
  });

  test("行标题：Claude Code 落到会话标题；终端标题压过 label，label 进 meta；shell 放组末", () => {
    expect(groups.find((g) => g.id === "w1")!.rows[0].title).toBe("修 skill 路由");
    expect(groups.find((g) => g.id === "w4")!.rows[0].title).toBe("重构");
    expect(groups.find((g) => g.id === "w4")!.rows[0].labelMeta).toBe("leader");
    const w2 = groups.find((g) => g.id === "w2")!;
    expect(w2.rows.map((r) => r.title)).toEqual(["评测设计"]);
    expect(w2.shells.map((r) => r.pane.paneId)).toEqual(["w2:p2"]);
  });

  test("窗格条顺序 = 组序展开，不含 shell", () => {
    expect(herdrModeStrip(groups).map((p) => p.paneId)).toEqual(["w3:p1", "w4:p1", "w1:p1", "w2:p1"]);
  });

  test("同名但路径不同 → 用短路径区分；分支不同 → 用分支", () => {
    const f = fleetOf([
      { workspace_id: "a", label: "app", tabs: [{ tab_id: "a:t1", panes: [pane("a:p1", "claude", "idle", null, { cwd: "/Users/x/one/app" })] }] },
      { workspace_id: "b", label: "app", tabs: [{ tab_id: "b:t1", panes: [pane("b:p1", "claude", "idle", null, { cwd: "/Users/x/two/app" })] }] },
    ]);
    const g = buildHerdrModeGroups(f, buildHerdrConsole(f, [], NOW));
    expect(g.map((x) => x.hint)).toEqual(["…/one/app", "…/two/app"]);
  });

  test("applyHerdrTitles：所有界面共用的标题里不再有 Claude Code", () => {
    const titled = applyHerdrTitles(panes, (id) => titles[id]);
    const byPane = new Map(titled.map((p) => [p.paneId, p.title]));
    expect(byPane.get("w1:p1")).toBe("修 skill 路由");
    expect(byPane.get("w4:p1")).toBe("重构");
    expect(byPane.get("w3:p1")).toBe("价值与方向");
    expect(titled.some((p) => /claude code/i.test(p.title))).toBe(false);
    // 未变的对象原样复用
    expect(titled.find((p) => p.paneId === "w2:p2")).toBe(panes.find((p) => p.paneId === "w2:p2")!);
  });

  test("herdrPaneTitle：离线会话优先会话标题，缺了沿用原标题", () => {
    const off = { ...panes[0], lane: "off" as const, view: null, sessionId: "s-x", title: "旧标题" };
    expect(herdrPaneTitle(off, () => "会话标题")).toBe("会话标题");
    expect(herdrPaneTitle(off)).toBe("旧标题");
  });

  test("herdrSendTarget：发往 = 分组名（撞名带后缀）· tab 标签（纯数字 → t2）", () => {
    const f = fleetOf([
      { workspace_id: "a", label: "app", tabs: [{ tab_id: "a:t1", label: "2", panes: [pane("a:p1", "claude", "idle", null, { cwd: "/Users/x/one/app" })] }] },
      { workspace_id: "b", label: "app", tabs: [{ tab_id: "b:t1", label: "review", panes: [pane("b:p1", "claude", "idle", null, { cwd: "/Users/x/two/app" })] }] },
    ]);
    const g = buildHerdrModeGroups(f, buildHerdrConsole(f, [], NOW));
    expect(herdrSendTarget(g, "a:p1")).toEqual({ workspace: "app …/one/app", tab: "t2" });
    expect(herdrSendTarget(g, "b:p1")).toEqual({ workspace: "app …/two/app", tab: "review" });
    expect(herdrSendTarget(g, "nope")).toBeNull();
  });

  test("没有 fleet → 空", () => {
    expect(buildHerdrModeGroups(null, [])).toEqual([]);
  });
});
