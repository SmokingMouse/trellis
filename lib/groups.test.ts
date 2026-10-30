import { describe, expect, test } from "bun:test";
import {
  GroupRoundBudget,
  buildButlerTaskDraft,
  clampSetting,
  formatUnseenDelta,
  isSkipReply,
  parseMentions,
  pickRoutedMember,
  planUserResponders,
  replyHandoffs,
  routeByName,
  type GroupTranscriptItem,
} from "./groups";

// 群聊纯函数（docs/roles-p2.md B）：@ 解析、挑人、增量格式、轮次预算。

const M = [
  { roleId: "r-zhou", name: "老周" },
  { roleId: "r-iris", name: "Iris" },
  { roleId: "r-lao", name: "老" },
  { roleId: "r-cr", name: "Code Reviewer" },
];

describe("parseMentions", () => {
  test("按出现顺序、去重", () => {
    expect(parseMentions("@Iris @老周 你们看，@Iris 再说", M)).toEqual({ roleIds: ["r-iris", "r-zhou"], all: false });
  });
  test("最长名字优先：@老周 不被 @老 截走", () => {
    expect(parseMentions("@老周你看 @老", M).roleIds).toEqual(["r-zhou", "r-lao"]);
  });
  test("中文名不设边界，ASCII 名要求后面不是字母数字", () => {
    expect(parseMentions("@老周你看", M).roleIds).toEqual(["r-zhou"]);
    expect(parseMentions("@Irish 不是 Iris", M).roleIds).toEqual([]);
    expect(parseMentions("@Iris，你看", M).roleIds).toEqual(["r-iris"]);
    expect(parseMentions("@iris 小写也认", M).roleIds).toEqual(["r-iris"]);
  });
  test("带空格的名字", () => {
    expect(parseMentions("请 @Code Reviewer 看下", M).roleIds).toEqual(["r-cr"]);
  });
  test("@所有人 / @all", () => {
    expect(parseMentions("@所有人 早", M).all).toBe(true);
    expect(parseMentions("@all hi", M).all).toBe(true);
    expect(parseMentions("@allen hi", M).all).toBe(false);
    expect(parseMentions("没有艾特", M)).toEqual({ roleIds: [], all: false });
  });
});

describe("planUserResponders", () => {
  test("有 @ 只让被 @ 的回，不看策略", () => {
    expect(planUserResponders("@Iris 你说", M, "all")).toEqual({ mode: "mention", roleIds: ["r-iris"] });
    expect(planUserResponders("@Iris 你说", M, "mention-only")).toEqual({ mode: "mention", roleIds: ["r-iris"] });
  });
  test("@所有人 = 全体必须回", () => {
    expect(planUserResponders("@所有人 说说", M, "route")).toEqual({
      mode: "all",
      roleIds: M.map((m) => m.roleId),
      optional: false,
    });
  });
  test("没 @ 按策略", () => {
    expect(planUserResponders("聊聊", M, "route")).toEqual({ mode: "route" });
    expect(planUserResponders("聊聊", M, "all")).toEqual({ mode: "all", roleIds: M.map((m) => m.roleId), optional: true });
    expect(planUserResponders("聊聊", M, "mention-only")).toEqual({ mode: "none" });
  });
});

describe("replyHandoffs / 路由", () => {
  test("去掉自己；@所有人 = 除自己外全体", () => {
    expect(replyHandoffs("@老周 @Iris 你俩看", M, "r-iris")).toEqual(["r-zhou"]);
    expect(replyHandoffs("@所有人", M.slice(0, 2), "r-iris")).toEqual(["r-zhou"]);
  });
  test("routeByName 取最早出现的名字", () => {
    expect(routeByName("Iris 和老周谁来", M)).toBe("r-iris");
    expect(routeByName("谁都没提", M)).toBeNull();
  });
  test("pickRoutedMember 认模型输出", () => {
    expect(pickRoutedMember("Iris", M)).toBe("r-iris");
    expect(pickRoutedMember("@老周", M)).toBe("r-zhou");
    expect(pickRoutedMember("我觉得都行", M)).toBeNull();
  });
});

describe("formatUnseenDelta", () => {
  const items: GroupTranscriptItem[] = [
    { seq: 1, roleId: null, name: "用户", text: "第一条" },
    { seq: 3, roleId: "r-iris", name: "Iris", text: "我是 Iris" },
    { seq: 5, roleId: "r-zhou", name: "老周", text: "我是老周" },
    { seq: 7, roleId: null, name: "用户", text: "  " },
    { seq: 8, roleId: null, name: "用户", text: "第二条" },
  ];
  test("只给没看过、不是自己说的", () => {
    const d = formatUnseenDelta(items, { selfRoleId: "r-zhou", lastSeenSeq: 1 });
    expect(d.text).toBe("[Iris]：我是 Iris\n\n[用户]：第二条");
    expect(d.count).toBe(2);
    expect(d.maxSeq).toBe(8);
  });
  test("maxItems 只留最近的", () => {
    const d = formatUnseenDelta(items, { selfRoleId: "x", lastSeenSeq: 0, maxItems: 2 });
    expect(d.text).toBe("[老周]：我是老周\n\n[用户]：第二条");
  });
  test("全看过了 = 空", () => {
    expect(formatUnseenDelta(items, { selfRoleId: "x", lastSeenSeq: 8 })).toEqual({ text: "", count: 0, maxSeq: 8 });
  });
});

describe("isSkipReply", () => {
  test("认（跳过）的几种写法", () => {
    for (const t of ["（跳过）", "跳过", " (跳过) ", "跳过。", "skip", "PASS"]) expect(isSkipReply(t)).toBe(true);
    expect(isSkipReply("我觉得不该跳过")).toBe(false);
  });
  test("流式前缀判断", () => {
    expect(isSkipReply("（", true)).toBe(true);
    expect(isSkipReply("（跳", true)).toBe(true);
    expect(isSkipReply("（我", true)).toBe(false);
  });
});

describe("GroupRoundBudget", () => {
  test("3 遍 10 条", () => {
    const b = new GroupRoundBudget(3, 10);
    for (let i = 0; i < 10; i++) {
      expect(b.canSpeak()).toBe(true);
      b.spoke();
    }
    expect(b.canSpeak()).toBe(false);
    expect(b.canAdvance()).toBe(true);
    b.advance();
    b.advance();
    expect(b.pass).toBe(3);
    expect(b.canAdvance()).toBe(false);
  });
  test("clampSetting", () => {
    expect(clampSetting(99, [1, 6], 3)).toBe(6);
    expect(clampSetting(0, [1, 6], 3)).toBe(1);
    expect(clampSetting("x", [1, 6], 3)).toBe(3);
    expect(clampSetting(2.6, [1, 6], 3)).toBe(3);
  });
});

test("buildButlerTaskDraft 带群名和发言原文", () => {
  const d = buildButlerTaskDraft("方案评审", [
    { name: "用户", text: "要不要做组织者" },
    { name: "Iris", text: "两周里 ≥3 次落成任务再做" },
  ]);
  expect(d).toContain("「方案评审」");
  expect(d).toContain("- [Iris] 两周里 ≥3 次落成任务再做");
});
