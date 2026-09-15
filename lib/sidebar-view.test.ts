import { expect, test } from "bun:test";
import { HOME_CLUSTER_KEY, SCRATCH_CLUSTER_KEY, type Session, type WorkspaceSummary, type ProjectSummary } from "./types";
import { herdrOffline, partitionEmptyWorkspaces, projectPresentation, selectSidebarSessions, sessionLocation, sidebarSource } from "./sidebar-view";

const session = (id: string, updatedAt: number, extra: Partial<Session> = {}): Session => ({ id, title: id, rootNodeId: id, createdAt: 0, updatedAt, mode: "chat", workspacePath: null, systemPrompt: null, archived: false, model: null, ...extra });
const workspace = (id: string): WorkspaceSummary => ({ id, name: id, path: `/${id}`, kind: "plain", gitBranch: null } as WorkspaceSummary);

test("排布使用同一会话集合、最后活动降序，归档默认排除且去重", () => {
  const active = [session("old", 1), session("new", 10)];
  const archived = [session("archive", 20, { archived: true }), active[0]];
  expect(selectSidebarSessions(active, archived, "all", false).map(s => s.id)).toEqual(["new", "old"]);
  expect(selectSidebarSessions(active, archived, "all", true).map(s => s.id)).toEqual(["archive", "new", "old"]);
  expect(active.map(s => s.id)).toEqual(["old", "new"]);
  const restored = selectSidebarSessions(active, [session("new", 0, { archived: true })], "all", true);
  expect(restored.find(s => s.id === "new")?.archived).toBe(false);
});

test("来源筛选覆盖 kind 与 origin，切来源和归档交叉生效", () => {
  const sessions = [session("web", 1), session("herdr", 2, { origin: "herdr" }), session("task", 3, { kind: "task" }), session("lark", 4, { origin: "lark" })];
  for (const source of ["web", "herdr", "task", "lark"] as const) expect(selectSidebarSessions(sessions, [], source, false).map(s => s.id)).toEqual([source]);
  expect(sidebarSource({ kind: "herdr", origin: "native" })).toBe("herdr");
  expect(sidebarSource({ kind: "lark" })).toBe("lark");
  expect(sidebarSource({ origin: "cli-import" })).toBe("web");
  const archive = session("archived-task", 8, { kind: "task", archived: true });
  expect(selectSidebarSessions(sessions, [archive], "herdr", true).map(s => s.id)).toEqual(["herdr"]);
  expect(selectSidebarSessions(sessions, [archive], "task", true).map(s => s.id)).toEqual(["archived-task", "task"]);
});

test("空工作区折叠只包含当前无会话的目录，展开保留原对象及分支信息", () => {
  const workspaces = [workspace("main"), { ...workspace("empty"), gitBranch: "feat/other" }];
  const result = partitionEmptyWorkspaces(workspaces, new Map([["main", [session("one", 1)]]]));
  expect(result.occupied.map(w => w.id)).toEqual(["main"]);
  expect(result.empty).toEqual([workspaces[1]]);
  expect(partitionEmptyWorkspaces(workspaces, new Map()).empty).toHaveLength(2);
});

test("收编会话保留外部来源、项目归属与跨来源时间排序", () => {
  const external = session("external", 5, { kind: "user", origin: "external", backend: "codex", workspaceId: "external-workspace" });
  const active = [session("older-web", 1), external, session("newer-web", 10)];
  expect(selectSidebarSessions(active, [], "all", false).map(s => s.id)).toEqual(["newer-web", "external", "older-web"]);
  expect(selectSidebarSessions(active, [], "external", false)).toEqual([external]);
  expect(selectSidebarSessions(active, [], "web", false).map(s => s.id)).toEqual(["newer-web", "older-web"]);
  expect(selectSidebarSessions([], [{ ...external, archived: true }], "external", true)).toHaveLength(1);
  const project = { id: "external-project", name: "外部会话", clusterKey: "trellis:external", gitRemote: null, workspaces: [workspace("external-workspace")] } as ProjectSummary;
  expect(sessionLocation(external, [project])).toBe("外部会话 / external-workspace");
});

// Herdr 在线却报不出 pane 的会话 = 已归档：默认藏起来，勾选才看得到。
const herdrSessions = [session("alive", 3, { origin: "herdr" }), session("dead", 2, { origin: "herdr" }), session("unbound", 1, { kind: "herdr" }), session("web", 4)];
const aliveMap = new Map([["alive", true], ["dead", false]]); // "unbound" 缺失条目 —— fleet 连死绑定都没返回
const offlineBy = (herdrAvailable: boolean) => (s: Session) => herdrOffline(s, herdrAvailable, aliveMap.get(s.id));

test("Herdr 在线时 pane 已消失的会话按归档对待，缺失绑定同样算离线", () => {
  const isOffline = offlineBy(true);
  expect(selectSidebarSessions(herdrSessions, [], "all", false, isOffline).map(s => s.id)).toEqual(["web", "alive"]);
  expect(selectSidebarSessions(herdrSessions, [], "all", true, isOffline).map(s => s.id)).toEqual(["web", "alive", "dead", "unbound"]);
  expect(selectSidebarSessions(herdrSessions, [], "herdr", false, isOffline).map(s => s.id)).toEqual(["alive"]);
  expect(selectSidebarSessions(herdrSessions, [], "herdr", true, isOffline).map(s => s.id)).toEqual(["alive", "dead", "unbound"]);
  // 只剩离线会话的工作区因此变空，自动折进「其它 N 个工作区」。
  const byWorkspace = new Map([["live", selectSidebarSessions([herdrSessions[0]], [], "all", false, isOffline)], ["dead-only", selectSidebarSessions([herdrSessions[1]], [], "all", false, isOffline)]]);
  expect(partitionEmptyWorkspaces([workspace("live"), workspace("dead-only")], byWorkspace).empty.map(w => w.id)).toEqual(["dead-only"]);
});

test("Herdr 不可用时一个都不藏，非 herdr 来源永不受离线规则影响", () => {
  const down = offlineBy(false);
  expect(selectSidebarSessions(herdrSessions, [], "all", false, down).map(s => s.id)).toEqual(["web", "alive", "dead", "unbound"]);
  expect(herdrOffline({ origin: "herdr" }, false, false)).toBe(false);
  expect(herdrOffline({ origin: "herdr" }, true, true)).toBe(false);
  expect(herdrOffline({ origin: "herdr" }, true, undefined)).toBe(true);
  for (const s of [{ kind: "task" }, { kind: "lark" }, { origin: "external" }, { origin: "cli-import" }] as Pick<Session, "kind" | "origin">[]) expect(herdrOffline(s, true, undefined)).toBe(false);
  // 真归档的非 herdr 会话仍按原规则走，离线谓词不插手。
  const archive = session("archived-web", 9, { archived: true });
  expect(selectSidebarSessions(herdrSessions, [archive], "web", false, offlineBy(true)).map(s => s.id)).toEqual(["web"]);
  expect(selectSidebarSessions(herdrSessions, [archive], "web", true, offlineBy(true)).map(s => s.id)).toEqual(["archived-web", "web"]);
});

test("伪项目只改展示名，按时间仍可定位项目和工作区", () => {
  expect(projectPresentation({ name: "旧名", clusterKey: SCRATCH_CLUSTER_KEY })).toEqual({ name: "暂存区（临时目录）", description: "没有所属仓库的临时目录与会话", icon: "◇" });
  expect(projectPresentation({ name: "旧名", clusterKey: HOME_CLUSTER_KEY }).name).toBe("主目录（个人目录）");
  const project = { id: "p", name: "仓库", clusterKey: "repo", gitRemote: null, workspaces: [workspace("main")] } as ProjectSummary;
  expect(sessionLocation(session("one", 1, { workspaceId: "main" }), [project])).toBe("仓库 / main");
  expect(sessionLocation(session("chat", 2), [project])).toBe("速记（无工作区）");
  expect(sessionLocation(session("orphan", 2, { workspaceId: "deleted", mode: "project" }), [project])).toBe("暂存区（临时目录）");
  expect(project.name).toBe("仓库");
});
