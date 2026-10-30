import { describe, expect, test } from "bun:test";
import {
  MEMORY_FILE_RE,
  copyRoleName,
  countMemories,
  groupMemories,
  isRoleNameTaken,
  memoryFileFromName,
  searchMemories,
} from "./role-manage";
import type { RoleMemory } from "./roles";

const rand = () => "a1b2c3";

describe("memoryFileFromName", () => {
  test("ASCII 名字转小写短横线", () => {
    expect(memoryFileFromName("Prod Port 3088", [], rand)).toBe("prod-port-3088.md");
    expect(memoryFileFromName("  --Deploy__via make!!  ", [], rand)).toBe("deploy-via-make.md");
  });

  test("中文 / 太短回落成 mem-<6hex>", () => {
    expect(memoryFileFromName("只报可复现的问题", [], rand)).toBe("mem-a1b2c3.md");
    expect(memoryFileFromName("看 PR", [], rand)).toBe("mem-a1b2c3.md");
    expect(memoryFileFromName("", [], rand)).toBe("mem-a1b2c3.md");
  });

  test("撞名加后缀", () => {
    expect(memoryFileFromName("deploy", ["deploy.md"], rand)).toBe("deploy-2.md");
    expect(memoryFileFromName("deploy", ["deploy.md", "deploy-2.md"], rand)).toBe("deploy-3.md");
  });

  test("长名字截断后仍合法", () => {
    const f = memoryFileFromName("a".repeat(200), [], rand);
    expect(MEMORY_FILE_RE.test(f)).toBe(true);
    expect(f.length).toBeLessThanOrEqual(64);
  });

  test("默认随机源产出合法名", () => {
    const f = memoryFileFromName("中文");
    expect(f).toMatch(/^mem-[0-9a-f]{6}\.md$/);
    expect(MEMORY_FILE_RE.test(f)).toBe(true);
  });
});

const mem = (p: Partial<RoleMemory>): RoleMemory => ({
  file: "x.md",
  name: "",
  description: "",
  type: "user",
  body: "",
  updatedAt: 0,
  ...p,
});

describe("记忆筛选", () => {
  const list = [
    mem({ file: "a.md", name: "中文交流", type: "user", updatedAt: 1 }),
    mem({ file: "b.md", name: "先跑类型检查", type: "feedback", updatedAt: 3 }),
    mem({ file: "c.md", name: "只报可复现", type: "feedback", updatedAt: 5, body: "Repro first" }),
    mem({ file: "d.md", name: "prod 3088", type: "project", updatedAt: 2 }),
  ];

  test("计数", () => {
    expect(countMemories(list)).toEqual({ all: 4, user: 1, feedback: 2, project: 1, reference: 0 });
  });

  test("搜索名字 / 正文，不分大小写", () => {
    expect(searchMemories(list, "repro").map((m) => m.file)).toEqual(["c.md"]);
    expect(searchMemories(list, " PROD ").map((m) => m.file)).toEqual(["d.md"]);
    expect(searchMemories(list, "").length).toBe(4);
  });

  test("分组：固定顺序、空组不出、组内新的在前", () => {
    const g = groupMemories(list, "all");
    expect(g.map((x) => x.type)).toEqual(["user", "feedback", "project"]);
    expect(g[1].items.map((m) => m.file)).toEqual(["c.md", "b.md"]);
    expect(groupMemories(list, "reference")).toEqual([]);
    expect(groupMemories(list, "project").map((x) => x.type)).toEqual(["project"]);
  });
});

describe("名字", () => {
  test("副本命名避开已有", () => {
    expect(copyRoleName("老周", ["老周"])).toBe("老周 副本");
    expect(copyRoleName("老周", ["老周", "老周 副本", "老周 副本 2"])).toBe("老周 副本 3");
  });

  test("重名判断排除自己", () => {
    const roles = [{ id: "1", name: "老周" }, { id: "2", name: "Iris" }];
    expect(isRoleNameTaken(" 老周 ", roles)).toBe(true);
    expect(isRoleNameTaken("老周", roles, "1")).toBe(false);
    expect(isRoleNameTaken("", roles)).toBe(false);
  });
});
