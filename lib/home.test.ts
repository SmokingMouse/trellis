import { describe, expect, test } from "bun:test";
import {
  formatWhen,
  greetingFor,
  isFailedRun,
  latestProblemRun,
  sessionPlace,
  upcomingTasks,
  workspaceLabels,
  type HomeTask,
} from "./home";
import type { ProjectSummary } from "./types";

const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m);

describe("greetingFor", () => {
  test("按时段", () => {
    expect(greetingFor(at(3))).toBe("夜深了");
    expect(greetingFor(at(8))).toBe("早上好");
    expect(greetingFor(at(12))).toBe("中午好");
    expect(greetingFor(at(15))).toBe("下午好");
    expect(greetingFor(at(21))).toBe("晚上好");
  });
});

describe("sessionPlace", () => {
  const projects: ProjectSummary[] = [{
    id: "p", name: "trellis", clusterKey: "k", gitRemote: null,
    workspaces: [
      { id: "w1", projectId: "p", name: "trellis", path: "/r/trellis", kind: "main", gitBranch: "main", createdBy: "t", lastUsedAt: 1, sessionCount: 1 },
      { id: "w2", projectId: "p", name: "home", path: "/wt/home", kind: "worktree", gitBranch: "home", createdBy: "t", lastUsedAt: 2, sessionCount: 1 },
    ],
  }];
  const labels = workspaceLabels(projects);
  test("同名只留项目名，worktree 带工作区名", () => {
    expect(sessionPlace({ mode: "project", workspaceId: "w1", workspacePath: "/r/trellis" }, labels)).toBe("trellis");
    expect(sessionPlace({ mode: "project", workspaceId: "w2", workspacePath: "/wt/home" }, labels)).toBe("trellis / home");
  });
  test("缺登记用路径末段，chat 是「对话」", () => {
    expect(sessionPlace({ mode: "project", workspaceId: null, workspacePath: "/x/foo/" }, labels)).toBe("foo");
    expect(sessionPlace({ mode: "chat", workspaceId: null, workspacePath: null }, labels)).toBe("对话");
  });
});

const task = (id: string, expr: string | null, lastRun: HomeTask["lastRun"] = null, enabled = true): HomeTask => ({
  id, name: id, enabled,
  triggers: expr ? [{ kind: "cron", enabled: true, config: { expr } }] : [],
  lastRun,
});
const run = (status: string, endedAt: number, errorMessage: string | null = null) => ({
  id: `r${endedAt}`, status, errorMessage, startedAt: endedAt - 1, endedAt, createdAt: endedAt - 2, sessionId: null, nodeId: null,
});

describe("upcomingTasks", () => {
  test("按下一次触发升序，停用 / 仅手动的排除", () => {
    const from = at(8, 30);
    const list = upcomingTasks([
      task("daily10", "0 10 * * *"),
      task("hourly", "0 * * * *"),
      task("manual", null),
      task("off", "*/5 * * * *", null, false),
    ], from);
    expect(list.map((x) => x.task.id)).toEqual(["hourly", "daily10"]);
    expect(list[0].at).toBe(at(9).getTime());
  });
});

describe("latestProblemRun", () => {
  test("interrupted 也算最近异常，但不算失败", () => {
    const p = latestProblemRun([
      task("a", null, run("error", 100)),
      task("b", null, run("error", 200, "interrupted")),
      task("c", null, run("done", 300)),
    ]);
    expect(p?.task.id).toBe("b");
    expect(isFailedRun(p!.run)).toBe(false);
  });
  test("没有异常返回 null", () => {
    expect(latestProblemRun([task("c", null, run("done", 300))])).toBeNull();
  });
});

describe("formatWhen", () => {
  test("今天 / 明天 / 日期", () => {
    const now = at(8);
    expect(formatWhen(at(9).getTime(), now)).toBe("今天 09:00");
    expect(formatWhen(new Date(2026, 8, 30, 7, 5).getTime(), now)).toBe("明天 07:05");
    expect(formatWhen(new Date(2026, 9, 3, 9, 0).getTime(), now)).toBe("10/3 09:00");
  });
});
