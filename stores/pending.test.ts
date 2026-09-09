import { afterEach, expect, test } from "bun:test";
import { useSessionStore } from "./sessionStore";
import type { PendingItem } from "@/lib/pending";

const originalFetch = globalThis.fetch;
const initial = useSessionStore.getState();
afterEach(() => { globalThis.fetch = originalFetch; useSessionStore.setState(initial, true); });
const item: PendingItem = { nodeId: "remote-node", sessionId: "other-session", sessionTitle: "其他会话", kind: "approval", summary: "检查文件", createdAt: 100,
  interaction: { toolUseId: "approval", toolName: "Bash", input: { command: "echo safe" } } };

test("未加载会话也能就地审批，回包后旧快照不能复活撤卡", async () => {
  useSessionStore.getState().ingestPending({ revision: 10, items: [item] });
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, options) => {
    body = JSON.parse(String(options?.body));
    expect(useSessionStore.getState().pendingSubmissions.has(item.nodeId)).toBeTrue();
    return Response.json({ ok: true, pending: { revision: 12, items: [] } });
  }) as typeof fetch;
  expect(await useSessionStore.getState().respondToInteraction(item.nodeId, "approval", { behavior: "allow", updatedInput: item.interaction.input })).toEqual({ ok: true });
  expect(body).toEqual({ toolUseId: "approval", behavior: "allow", updatedInput: { command: "echo safe" } });
  useSessionStore.getState().ingestPending({ revision: 11, items: [item] });
  expect(useSessionStore.getState().pending.items).toHaveLength(0);
  expect(useSessionStore.getState().pendingSubmissions.size).toBe(0);
});

test("网络失败恢复待办，另一端已撤卡则不复活", async () => {
  useSessionStore.getState().ingestPending({ revision: 10, items: [item] });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await useSessionStore.getState().respondToInteraction(item.nodeId, "approval", { behavior: "deny" })).toEqual({ ok: false, reason: "error" });
  expect(useSessionStore.getState().pending.items).toHaveLength(1);
  expect(useSessionStore.getState().pendingSubmissions.size).toBe(0);
  globalThis.fetch = (async () => {
    useSessionStore.getState().ingestPending({ revision: 12, items: [] });
    throw new Error("response lost");
  }) as unknown as typeof fetch;
  await useSessionStore.getState().respondToInteraction(item.nodeId, "approval", { behavior: "deny" });
  expect(useSessionStore.getState().pending.items).toHaveLength(0);
});

test("新导航取代 hydrate，旧请求取消不会清空新会话或留下 hydrateError", async () => {
  useSessionStore.setState({ hydrated: false, hydrateError: null, session: null, nodes: {} });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/old")) {
      started();
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (String(url).endsWith("/new")) return Response.json({ session: { id: "new", title: "new", mode: "chat", rootNodeId: "n" }, nodes: [] });
    return Response.json({ providers: [], bookmarks: [] });
  }) as typeof fetch;
  const hydrate = useSessionStore.getState().hydrate("old");
  await ready;
  await useSessionStore.getState().loadSession("new");
  await hydrate;
  expect(useSessionStore.getState().session?.id).toBe("new");
  expect(useSessionStore.getState().hydrateError).toBeNull();
  expect(useSessionStore.getState().hydrated).toBeTrue();
});
