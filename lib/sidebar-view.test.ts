import { expect, test } from "bun:test";
import { HOME_CLUSTER_KEY, SCRATCH_CLUSTER_KEY, type Session, type WorkspaceSummary, type ProjectSummary } from "./types";
import { partitionEmptyWorkspaces, projectPresentation, selectSidebarSessions, sessionLocation, sidebarSource } from "./sidebar-view";

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

test("伪项目只改展示名，按时间仍可定位项目和工作区", () => {
  expect(projectPresentation({ name: "旧名", clusterKey: SCRATCH_CLUSTER_KEY })).toEqual({ name: "暂存区（临时目录）", description: "没有所属仓库的临时目录与会话", icon: "◇" });
  expect(projectPresentation({ name: "旧名", clusterKey: HOME_CLUSTER_KEY }).name).toBe("主目录（个人目录）");
  const project = { id: "p", name: "仓库", clusterKey: "repo", gitRemote: null, workspaces: [workspace("main")] } as ProjectSummary;
  expect(sessionLocation(session("one", 1, { workspaceId: "main" }), [project])).toBe("仓库 / main");
  expect(sessionLocation(session("chat", 2), [project])).toBe("速记（无工作区）");
  expect(sessionLocation(session("orphan", 2, { workspaceId: "deleted", mode: "project" }), [project])).toBe("暂存区（临时目录）");
  expect(project.name).toBe("仓库");
});
