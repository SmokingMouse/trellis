import { describe, expect, it, mock } from "bun:test";
import { matchCommands, parseCommand, REMEMBER_PREFIX, type CommandStore } from "./commands";

// 命令表按场景区分（docs/roles-p1.md）：角色对话里 /new = 新话题、多一个 /remember；
// 普通场景一字不变。

function fakeStore(over: Partial<CommandStore> = {}): CommandStore {
  return {
    session: { id: "s1" },
    newConversation: mock(() => {}),
    archiveSession: mock(() => {}),
    setSearchOpen: mock(() => {}),
    setComposeRootOpen: mock(() => {}),
    setProvider: mock(() => {}),
    provider: "claude-opus",
    providerCatalog: [],
    ...over,
  };
}

describe("默认场景", () => {
  it("/new 仍是新会话", () => {
    const store = fakeStore();
    const parsed = parseCommand("/new");
    expect(parsed?.command.name).toBe("new");
    parsed!.command.run(store, parsed!.args);
    expect(store.newConversation).toHaveBeenCalledTimes(1);
    expect(store.setComposeRootOpen).not.toHaveBeenCalled();
  });

  it("没有 /remember，按普通文本发出", () => {
    expect(parseCommand("/remember 报告多用表格")).toBeNull();
    expect(matchCommands("/rem")).toEqual([]);
  });
});

describe("角色场景", () => {
  it("/new 不带字 = 打开新话题输入（同 /clear），不开新会话", () => {
    const store = fakeStore();
    const parsed = parseCommand("/new", "role");
    expect(parsed?.command.name).toBe("new");
    expect(parsed!.command.run(store, parsed!.args)).toBeUndefined();
    expect(store.setComposeRootOpen).toHaveBeenCalledWith(true);
    expect(store.newConversation).not.toHaveBeenCalled();
  });

  it("/new 带首句 = 直接在当前会话开新根", () => {
    const streamRoot = mock(() => Promise.resolve(true));
    const store = fakeStore({ streamRoot });
    const parsed = parseCommand("/new 帮我看下这个 PR", "role");
    parsed!.command.run(store, parsed!.args);
    expect(streamRoot).toHaveBeenCalledWith("帮我看下这个 PR", { attachToCurrentSession: true });
    expect(store.setComposeRootOpen).not.toHaveBeenCalled();
  });

  it("/new 在草稿态（还没会话）给提示、不动作", () => {
    const store = fakeStore({ session: null });
    const parsed = parseCommand("/new", "role");
    expect(parsed!.command.run(store, "")).toBeString();
    expect(store.setComposeRootOpen).not.toHaveBeenCalled();
  });

  it("/remember 按普通消息发出，带「请记下：」前缀", () => {
    const sendMessage = mock(() => {});
    const store = fakeStore({ sendMessage });
    const parsed = parseCommand("/remember 报告多用表格", "role");
    expect(parsed?.command.name).toBe("remember");
    expect(parsed!.command.run(store, parsed!.args)).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(`${REMEMBER_PREFIX}报告多用表格`);
  });

  it("/remember 不带内容只回用法", () => {
    const sendMessage = mock(() => {});
    const parsed = parseCommand("/remember", "role");
    expect(parsed!.command.run(fakeStore({ sendMessage }), "")).toContain("用法");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("补全里 /new 和 /remember 排最前，其它命令照常可用", () => {
    const names = matchCommands("/", "role").map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["new", "remember"]);
    expect(names).toContain("clear");
    expect(names).toContain("archive");
    expect(names.filter((n) => n === "new")).toHaveLength(1);
    expect(matchCommands("/new", "role")[0].description).toContain("新话题");
  });
});
