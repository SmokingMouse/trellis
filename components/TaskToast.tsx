"use client";
import { useEffect, useState } from "react";
import { ToastShell } from "@/components/ui/Toast";

// S88: 任务执行完成 / 失败的站内提醒。
//
// 自带 SSE 订阅 + 自己那点本地状态，**不进 sessionStore** —— 它和会话树、流式
// 状态零交集，塞进那个 3000 行的 store 只会让它更难读。
//
// 与 DoneToast 共用右下角堆叠位（后者 z-40，这里 z-40 且更靠上一点），
// 视觉走同一套 ToastShell，用户不会觉得是两个系统。

type TaskEvent =
  | { type: "run_started"; taskId: string; runId: string }
  | { type: "run_updated"; taskId: string; runId: string }
  | { type: "run_finished"; taskId: string; runId: string; status: string }
  | { type: "ping" };

type Item = {
  runId: string;
  status: string;
  taskName: string;
  link: string | null;
};

const AUTO_DISMISS_MS = 8000;

export function TaskToast() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    let retryTimer = 0;

    // 结构照抄 useCliSyncEvents：手写 SSE 读取 + 断线重连。用 EventSource 会
    // 少几行，但它不能带 signal、不好在 unmount 时干净收摊。
    async function run() {
      try {
        const res = await fetch("/api/tasks/events", {
          signal: ctrl.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6)) as TaskEvent;
            if (ev.type !== "run_finished") continue;
            // 成功且没人在看任务页时不打扰？—— 不做这个判断：notify_on 已经在
            // 服务端决定了要不要**外部**推送，站内 toast 是廉价的、看一眼就走。
            void hydrateItem(ev.taskId, ev.runId, ev.status).then((it) => {
              if (!it || cancelled) return;
              setItems((prev) => [...prev, it]);
              window.setTimeout(
                () => setItems((prev) => prev.filter((x) => x.runId !== it.runId)),
                AUTO_DISMISS_MS,
              );
            });
          }
        }
      } catch {
        /* transient —— 下面重连 */
      } finally {
        if (!cancelled) retryTimer = window.setTimeout(run, 2000);
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ctrl.abort();
    };
  }, []);

  if (!items.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
      {items.map((it) => (
        <ToastShell
          key={it.runId}
          tone={it.status === "done" ? "positive" : "danger"}
          className="px-3 py-2 cursor-pointer"
          onClick={() => {
            if (it.link) window.location.href = it.link;
          }}
        >
          <div className="text-ui">
            ⏱ 任务「{it.taskName}」{statusText(it.status)}
          </div>
          {it.link && (
            <div className="text-label text-ink-faint">点击查看这次执行</div>
          )}
        </ToastShell>
      ))}
    </div>
  );
}

function statusText(s: string): string {
  return { done: "完成", error: "失败", timeout: "超时", skipped: "跳过" }[s] ?? s;
}

/** SSE 事件只带 id，名字和深链要现查一次 —— 事件里塞全量数据会让广播变重，
 * 而这个查询只在真的要弹 toast 时发生。 */
async function hydrateItem(
  taskId: string,
  runId: string,
  status: string,
): Promise<Item | null> {
  try {
    const [taskRes, runsRes] = await Promise.all([
      fetch(`/api/tasks/${taskId}`),
      fetch(`/api/tasks/${taskId}/runs?limit=10`),
    ]);
    const task = (await taskRes.json())?.task;
    const runs = (await runsRes.json())?.runs ?? [];
    const run = runs.find((r: { id: string }) => r.id === runId);
    if (!task) return null;
    return {
      runId,
      status,
      taskName: task.name as string,
      link: run?.sessionId ? `/?session=${run.sessionId}&node=${run.nodeId}` : null,
    };
  } catch {
    return null;
  }
}
