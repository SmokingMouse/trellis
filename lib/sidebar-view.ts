import { HOME_CLUSTER_KEY, SCRATCH_CLUSTER_KEY, type ProjectSummary, type Session, type WorkspaceSummary } from "./types";

export type SidebarSource = "all" | "web" | "herdr" | "task" | "lark";
export type SidebarLayout = "project" | "time";
export const SIDEBAR_V2 = process.env.NEXT_PUBLIC_TRELLIS_SIDEBAR_V2 !== "off" && process.env.NEXT_PUBLIC_TRELLIS_SIDEBAR_V2 !== "0";

export function sidebarSource(s: Pick<Session, "kind" | "origin">): SidebarSource {
  if (s.kind === "herdr" || s.origin === "herdr") return "herdr";
  if (s.kind === "task") return "task";
  if (s.kind === "lark" || s.origin === "lark") return "lark";
  return "web";
}

export function selectSidebarSessions(sessions: Session[], archived: Session[], source: SidebarSource, includeArchived: boolean): Session[] {
  // A restored session may briefly remain in the lazy archive response.
  // The active list wins that overlap so a successful restore stays visible.
  return [...new Map([...(includeArchived ? archived : []), ...sessions].map(s => [s.id, s])).values()]
    .filter(s => (includeArchived || !s.archived) && (source === "all" || sidebarSource(s) === source))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function projectPresentation(p: Pick<ProjectSummary, "name" | "clusterKey">) {
  if (p.clusterKey === SCRATCH_CLUSTER_KEY) return { name: "暂存区（临时目录）", description: "没有所属仓库的临时目录与会话", icon: "◇" };
  if (p.clusterKey === HOME_CLUSTER_KEY) return { name: "主目录（个人目录）", description: "直接在用户主目录中进行的会话", icon: "⌂" };
  return { name: p.name, description: "", icon: "" };
}

export function partitionEmptyWorkspaces(workspaces: WorkspaceSummary[], byWorkspace: Map<string, Session[]>) {
  return { occupied: workspaces.filter(w => (byWorkspace.get(w.id)?.length ?? 0) > 0), empty: workspaces.filter(w => !byWorkspace.get(w.id)?.length) };
}

export function sessionLocation(s: Session, projects: ProjectSummary[]): string {
  for (const p of projects) {
    const w = p.workspaces.find(w => w.id === s.workspaceId);
    if (w) return `${projectPresentation(p).name} / ${w.name}`;
  }
  return (s.mode || "chat") === "chat" && !s.workspaceId ? "速记（无工作区）" : "暂存区（临时目录）";
}
