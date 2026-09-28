"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { toast } from "@/components/ui";
import { bindPageStream } from "@/lib/page-stream";

// S88: 任务执行完成 / 失败的站内提醒。
//
// 自带 SSE 订阅 + 自己那点本地状态，**不进 sessionStore** —— 它和会话树、流式
// 状态零交集，塞进那个 3000 行的 store 只会让它更难读。
// （S117 起有两处最小交集：run 事件 bump 一下侧栏、点击 toast 直接切会话 ——
// 都是对既有 store action 的调用，本地状态仍然自持。）
//
// W4 起不自己画 UI：结果进全站 sonner 队列（右下角），与 DoneToast 等同一堆叠。

type TaskEvent =
  | { type: "run_started"; taskId: string; runId: string }
  | { type: "run_updated"; taskId: string; runId: string }
  | { type: "run_finished"; taskId: string; runId: string; status: string }
  | { type: "ping" };

type Item = {
  runId: string;
  status: string;
  taskName: string;
  sessionId: string | null;
  nodeId: string | null;
};

const AUTO_DISMISS_MS = 8000;

export function TaskToast() {
  useEffect(() => {
    let ctrl = new AbortController();
    let cancelled = false;
    let retryTimer = 0;

    // 结构照抄 useCliSyncEvents：手写 SSE 读取 + 断线重连。用 EventSource 会
    // 少几行，但它不能带 signal、不好在 unmount 时干净收摊。
    async function run() {
      const signal = ctrl.signal;
      try {
        const res = await fetch("/api/tasks/events", {
          signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled && !signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6)) as TaskEvent;
            // S117: 任务会话在侧栏有分组了 —— 首次执行懒建的会话行、执行结束的
            // 角标都靠重拉 /api/sessions 长出来。getState() 取免得进依赖数组。
            if (ev.type === "run_started" || ev.type === "run_finished") {
              useSessionStore.getState().bumpSessionsRevision();
            }
            if (ev.type !== "run_finished") continue;
            // 成功且没人在看任务页时不打扰？—— 不做这个判断：notify_on 已经在
            // 服务端决定了要不要**外部**推送，站内 toast 是廉价的、看一眼就走。
            void hydrateItem(ev.taskId, ev.runId, ev.status).then((it) => {
              if (!it || cancelled) return;
              showTaskToast(it);
            });
          }
        }
      } catch {
        /* transient —— 下面重连 */
      } finally {
        if (!cancelled && !signal.aborted) retryTimer = window.setTimeout(run, 2000);
      }
    }

    void run();
    const stop = () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ctrl.abort();
    };
    return bindPageStream(window, stop, () => {
      if (!cancelled) return;
      cancelled = false;
      ctrl = new AbortController();
      void run();
    });
  }, []);

  return null;
}

// 同一次执行只弹一条（id = runId，重复事件就地更新）。done → 成功；error → 失败；
// timeout → 警告；skipped → 普通提示。8 秒自动消失（悬停暂停）。
function showTaskToast(it: Item) {
  const title = `任务「${it.taskName}」${statusText(it.status)}`;
  const sessionId = it.sessionId;
  const opts = {
    id: `task-run:${it.runId}`,
    duration: AUTO_DISMISS_MS,
    action: sessionId
      ? {
          label: "查看执行",
          onClick: () => {
            // S117: 原来是 window.location.href 整页刷新（store 全丢重启）。
            // 直接驱动 store 切过去即可 —— 与侧栏点行同一条路径，tab / 高亮自然跟上。
            const st = useSessionStore.getState();
            const nodeId = it.nodeId;
            void st.previewSession(sessionId).then(() => {
              if (nodeId) st.setActiveNode(nodeId);
            });
          },
        }
      : undefined,
  };
  if (it.status === "done") toast.success(title, opts);
  else if (it.status === "error") toast.error(title, opts);
  else if (it.status === "timeout") toast.warning(title, opts);
  else toast.info(title, opts);
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
      sessionId: (run?.sessionId as string | undefined) ?? null,
      nodeId: (run?.nodeId as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}
