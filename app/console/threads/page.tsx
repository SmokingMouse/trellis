"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Thread } from "@smokingmouse/agent-server/protocol";
import { ThreadLogView } from "@/components/ThreadLogView";
import "./threads.css";

export default function ThreadsPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (next?: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/as/threads${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录。" : "暂时无法连接会话服务，请稍后重试。");
      const data = await response.json();
      setThreads(previous => next ? [...new Map([...previous, ...data.threads].map(thread => [thread.id, thread])).values()] : data.threads);
      setCursor(data.nextCursor ?? null);
      setError("");
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <main className="as-shadow">
    <header className="as-header">
      <Link href="/" className="as-back">← Trellis</Link>
      <span className="as-mode">只读观察</span>
      <h1>会话日志</h1>
      <p>从桌面到手机，查看同一段工作。</p>
    </header>
    <div className="as-workspace">
      <nav aria-label="会话列表" className="as-thread-list">
        <div className="as-list-heading"><h2>会话 <small>{threads.length}</small></h2><button disabled={loading} onClick={() => void load()}>刷新</button></div>
        {error && <p role="alert">{error}</p>}
        {!error && !threads.length && <p className="as-empty">{loading ? "正在读取…" : "暂无会话。在原客户端开始后刷新此处。"}</p>}
        {threads.map(thread => <button key={thread.id} data-as-thread={thread.id} aria-pressed={selected?.id === thread.id} className="as-thread" onClick={() => setSelected(thread)}>
          <strong>{thread.title || thread.id}</strong>
          <span>{thread.backend} · {thread.status.type}</span>
          <small>{thread.cwd}</small>
        </button>)}
        {cursor && <button disabled={loading} onClick={() => void load(cursor)}>加载更多</button>}
      </nav>
      <div className="as-detail">
        {selected ? <><h2 className="as-selected-title">{selected.title || selected.id}</h2><ThreadLogView key={selected.id} threadId={selected.id} /></>
          : <div className="as-placeholder"><span>◎</span><h2>选择一段会话</h2><p>回复、思考、命令与文件改动会在这里实时出现。</p></div>}
      </div>
    </div>
  </main>;
}
