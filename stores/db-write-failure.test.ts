import { afterEach, beforeEach, expect, test } from "bun:test";
import { useSessionStore } from "./sessionStore";
import type { Session } from "@/lib/types";

// S176 前端侧：SQLite 写失败必须变成**看得见的**错误 —— 节点从「进行中」落到
// error 态、文案说人话；而不是把卡片一直挂在转圈上。

const initial = useSessionStore.getState();
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

const DISK_FULL_MSG =
  "数据库写入失败：磁盘空间不足（SQLITE_FULL）。这一轮的内容没能存下来。请先清理 ~/.trellis/data.db 所在分区（或把 TRELLIS_DB_PATH 指到更大的盘），再重试提问。";

const session: Session = {
  id: "s1",
  title: "s1",
  rootNodeId: "s1-root",
  mode: "chat",
  workspacePath: null,
  systemPrompt: null,
  archived: false,
  model: null,
  createdAt: 1,
  updatedAt: 2,
};

function sse(events: Record<string, unknown>[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
    },
  });
  useSessionStore.setState(initial, true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

test("建行就写失败（507）：错误正文要透到界面，不是一句 HTTP 507", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/api/chat")) {
      return Response.json(
        { error: DISK_FULL_MSG, code: "SQLITE_FULL" },
        { status: 507 },
      );
    }
    return Response.json({});
  }) as typeof fetch;

  useSessionStore.setState({ session, nodes: {} });
  await useSessionStore.getState().streamRoot("磁盘满的时候提问", {
    attachToCurrentSession: true,
  });

  const s = useSessionStore.getState();
  expect(s.streamAlert).toContain("磁盘");
  expect(s.streamAlert).toContain("数据库写入失败");
  expect(s.streamAlert).not.toContain("HTTP 507");
  // 乐观占位卡必须撤掉 —— 留着就是一张永远转圈的卡
  expect(
    Object.values(s.nodes).filter((n) => n.status === "streaming"),
  ).toHaveLength(0);
});

test("流中途落库失败：节点落 error 态、带人话文案，不再挂着 streaming", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/api/chat")) {
      return sse([
        {
          type: "created",
          node: {
            id: "n1",
            sessionId: "s1",
            parentId: "s1-root",
            question: "会在磁盘满的时候回答",
            response: "",
            status: "streaming",
            createdAt: 3,
            siblingIndex: 0,
          },
        },
        { type: "error", message: DISK_FULL_MSG },
      ]);
    }
    return Response.json({});
  }) as typeof fetch;

  useSessionStore.setState({ session, nodes: {} });
  await useSessionStore
    .getState()
    .streamBranch("s1-root", "会在磁盘满的时候回答", null);

  const node = useSessionStore.getState().nodes["n1"];
  expect(node).toBeDefined();
  expect(node.status).toBe("error");
  expect(node.errorMessage).toContain("磁盘");
  expect(node.errorMessage).toContain("数据库写入失败");
  expect(
    Object.values(useSessionStore.getState().nodes).filter(
      (n) => n.status === "streaming",
    ),
  ).toHaveLength(0);
});

test("读不出 body 时仍退回状态码（不至于变成空白报错）", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/api/chat")) {
      return new Response("<html>502</html>", { status: 502 });
    }
    return Response.json({});
  }) as typeof fetch;

  useSessionStore.setState({ session, nodes: {} });
  await useSessionStore.getState().streamRoot("x", { attachToCurrentSession: true });
  expect(useSessionStore.getState().streamAlert).toContain("HTTP 502");
});
