"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { networkTitle, pendingOutboxCount } from "@/lib/outbox";
import { outbox } from "@/lib/outbox-client";
import { pageEvents } from "@/lib/page-events";

// 弱网时标题位显示「等待网络 / 连接中…」，不弹横幅：
//   - navigator.onLine + online / offline 事件；
//   - 页面级推送流 /api/events 的连接状态（lib/page-events，与 herdr / cli 推送同一条流）；
//   - Outbox 里还在等重发的消息条数。
// 「连接中…」延迟一会儿才显示，免得推送流秒级重连时标题闪一下。
const CONNECTING_DELAY_MS = 1_500;
const EMPTY: never[] = [];

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

// 推送流状态：「曾经连上过」要跨组件记住，放模块级
let streamEver = false;
function subscribeStream(listener: () => void): () => void {
  return pageEvents().onStatus(({ connected }) => {
    if (connected) streamEver = true;
    listener();
  });
}
function streamSnapshot(): "up" | "down" | "never" {
  const connected = pageEvents().connected;
  if (connected) streamEver = true;
  return connected ? "up" : streamEver ? "down" : "never";
}

export function useNetworkTitle(): "等待网络" | "连接中…" | null {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const items = useSyncExternalStore(outbox().subscribe, outbox().snapshot, () => EMPTY);
  const stream = useSyncExternalStore(subscribeStream, streamSnapshot, () => "never" as const);
  const title = networkTitle({
    online,
    streamConnected: stream === "up",
    streamEverConnected: stream !== "never",
    pending: pendingOutboxCount(items),
  });

  // 每进入一次「连接中…」算一轮；这一轮持续够久才显示
  const [prevTitle, setPrevTitle] = useState(title);
  const [episode, setEpisode] = useState(0);
  const [shownEpisode, setShownEpisode] = useState(-1);
  if (title !== prevTitle) {
    setPrevTitle(title);
    if (title === "连接中…") setEpisode((n) => n + 1);
  }
  useEffect(() => {
    if (title !== "连接中…") return;
    const timer = setTimeout(() => setShownEpisode(episode), CONNECTING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [title, episode]);
  if (title !== "连接中…") return title;
  return shownEpisode === episode ? title : null;
}
