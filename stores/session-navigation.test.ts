import { afterEach, beforeEach, expect, test } from "bun:test";
import { useSessionStore } from "./sessionStore";
import type { Session } from "@/lib/types";

const initial = useSessionStore.getState();
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let storage: Map<string, string>;
let requests: string[];

const session = (id: string): Session => ({ id, title: id, rootNodeId: `${id}-root`, mode: "chat", workspacePath: null, systemPrompt: null, archived: false, model: null, createdAt: 1, updatedAt: 2 });
const response = (id: string) => Response.json({ session: session(id), nodes: [
  { id: `${id}-root`, sessionId: id, parentId: null, question: "root", response: "root answer", status: "done", createdAt: 1, siblingIndex: 0 },
  { id: `${id}-tip`, sessionId: id, parentId: `${id}-root`, question: "tip", response: "tip answer", status: "done", createdAt: 2, siblingIndex: 0 },
] });

beforeEach(() => {
  storage = new Map();
  requests = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } } });
  useSessionStore.setState(initial, true);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return response(url.split("/").at(-1)!);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  useSessionStore.setState(initial, true);
});

test("会话行 previewSession 恢复上次 node、阅读偏移和视图；重复点击不重载", async () => {
  storage.set("trellis-view:a", JSON.stringify({ activeNodeId: "a-tip", viewMode: "linear", lastViewed: { nodeId: "a-root", offset: 37 } }));
  await useSessionStore.getState().previewSession("a");
  expect(useSessionStore.getState()).toMatchObject({ previewSessionId: "a", activeNodeId: "a-tip", viewMode: "linear", readingPosition: { nodeId: "a-root", offset: 37 } });
  await useSessionStore.getState().previewSession("a");
  expect(requests).toEqual(["/api/sessions/a"]);
});

test("旧 canvas 存储保留节点和偏移，但恢复为 linear", async () => {
  storage.set("trellis-view:a", JSON.stringify({ activeNodeId: "a-tip", viewMode: "canvas", lastViewed: { nodeId: "a-root", offset: 37 } }));
  await useSessionStore.getState().previewSession("a");
  expect(useSessionStore.getState()).toMatchObject({ activeNodeId: "a-tip", viewMode: "linear", readingPosition: { nodeId: "a-root", offset: 37 } });
  useSessionStore.getState().setViewMode("canvas");
  expect(useSessionStore.getState().viewMode).toBe("linear");
});

test("地图选择关闭手机 sheet，落回线性指定节点；重复选择仍触发定位", async () => {
  await useSessionStore.getState().previewSession("a");
  useSessionStore.setState({ mobileTreePanelOpen: true });
  useSessionStore.getState().jumpFromMap("a-tip");
  expect(useSessionStore.getState()).toMatchObject({ activeNodeId: "a-tip", viewMode: "linear", mobileTreePanelOpen: false, readingPosition: { nodeId: "a-tip", offset: 0 }, mapNavigation: { nodeId: "a-tip", sequence: 1 } });
  useSessionStore.getState().jumpFromMap("a-tip");
  expect(useSessionStore.getState().mapNavigation?.sequence).toBe(2);
  useSessionStore.getState().jumpFromMap("deleted");
  expect(useSessionStore.getState().mapNavigation?.sequence).toBe(2);
});

test("openNodeInSession 跨会话落到指定分支，同会话不重载，已删除节点不覆盖落点", async () => {
  await useSessionStore.getState().openNodeInSession("a", "a-tip");
  expect(useSessionStore.getState().activeNodeId).toBe("a-tip");
  await useSessionStore.getState().openNodeInSession("a", "a-root");
  expect(useSessionStore.getState().activeNodeId).toBe("a-root");
  await useSessionStore.getState().openNodeInSession("a", "deleted");
  expect(useSessionStore.getState().activeNodeId).toBe("a-root");
  expect(requests).toEqual(["/api/sessions/a"]);
});

test("较慢的跨会话分支跳转不能覆盖随后选中的会话", async () => {
  let finishA!: (response: Response) => void;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith("/a")
    ? new Promise<Response>(resolve => { finishA = resolve; })
    : response("b")) as typeof fetch;
  const slow = useSessionStore.getState().openNodeInSession("a", "a-tip");
  await useSessionStore.getState().previewSession("b");
  finishA(response("a"));
  await slow;
  expect(useSessionStore.getState().session?.id).toBe("b");
  expect(useSessionStore.getState().activeNodeId).not.toBe("a-tip");
});
