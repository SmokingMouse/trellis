"use client";
import { useEffect, useState } from "react";
import type { ThreadEvent } from "@/lib/as-thread-event";
import { useSessionStore } from "@/stores/sessionStore";
import type { Thread } from "@smokingmouse/agent-server/protocol";

const modes = ["default", "acceptEdits", "plan", "dontAsk"];
const labels: Record<string,string> = { default: "逐次确认", acceptEdits: "允许编辑", plan: "计划模式", dontAsk: "不询问", full: "绕过审批", bypassPermissions: "绕过审批" };
const observers = new Map<string, {source:EventSource; listeners:Set<(event:ThreadEvent)=>void>; snapshot?:ThreadEvent}>();
function observeThread(threadId:string, nodeId:string, listener:(event:ThreadEvent)=>void) {
  let observer=observers.get(threadId);
  if (!observer) {
    observer={source:new EventSource(`/api/nodes/${encodeURIComponent(nodeId)}/as/stream`),listeners:new Set()};
    observers.set(threadId,observer);
    const active=observer;
    active.source.onmessage=event=>{
      const data=JSON.parse(event.data) as ThreadEvent;
      if(data.type==="snapshot") active.snapshot=data;
      for(const callback of active.listeners) callback(data);
    };
  }
  observer.listeners.add(listener);
  if(observer.snapshot) listener(observer.snapshot);
  const active=observer;
  return ()=>{active.listeners.delete(listener);if(!active.listeners.size){active.source.close();observers.delete(threadId);}};
}
export function AsProjectControls({ nodeId }: { nodeId: string }) {
  const threadBound = useSessionStore(s => s.session?.bindingType === "thread");
  const nodeStatus = useSessionStore(s => s.nodes[nodeId]?.status);
  const [thread, setThread] = useState<Thread | null>(null);
  const external = useSessionStore(s => s.session?.origin === "external");
  const [supported, setSupported] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notice = useSessionStore(s => s.nodes[nodeId]?.asNotice);
  useEffect(() => {
    if (!threadBound) return;
    let stopped = false, opening = false, unsubscribe: (()=>void) | undefined;
    const pendingIds = new Set<string>();
    const key = `trellis-as-ui:${nodeId}`;
    let saved: {logs:string[]; resolved:string[]} = { logs: [], resolved: [] };
    try { saved = JSON.parse(sessionStorage.getItem(key) ?? JSON.stringify(saved)); } catch {}
    setLogs(saved.logs); setResolved(saved.resolved);
    const remember = () => { try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch {} };
    async function open() {
      if(opening) return;
      opening=true;
      try {
        const response = await fetch(`/api/nodes/${nodeId}/as`);
        const value = await response.json();
        if (stopped) return;
        if (!response.ok) { setError("Agent 服务暂不可达"); return; }
        if (!value.thread) return;
        setThread(value.thread); setSupported(value.permissionSet); setError("");
        if (value.resolved?.length) { saved.resolved = value.resolved; setResolved(saved.resolved); remember(); }
        unsubscribe = observeThread(value.thread.id, nodeId, data => {
          if (data.type === "snapshot") {
            setThread(data.snapshot.thread);
            pendingIds.clear();
            for (const request of data.snapshot.pendingRequests) if (request.params.turnId === value.turnId) pendingIds.add(request.params.requestId);
            return;
          }
          if (data.type !== "notification") return;
          const { method, params } = data.notification;
          if (method === "thread/pendingRequests" && params.turnId === value.turnId && params.status === "pending") pendingIds.add(params.requestId);
          if (method === "thread/permission/changed") setThread(t => t ? { ...t, permission: params.permission } : t);
          if (method === "thread/status/changed") setThread(t => t ? {...t,status:params.status} : t);
          if (method === "thread/closed") setThread(t => t ? {...t,status:{type:"closed"}} : t);
          if (method === "thread/engineEvent" && (!params.turnId || params.turnId === value.turnId)) {
            saved.logs = [...saved.logs, `${params.subtype}: ${JSON.stringify(params.payload)}`].slice(-100);
            setLogs(saved.logs); remember();
          }
          if (method === "serverRequest/resolved" && pendingIds.has(params.requestId)) {
            saved.resolved = [...saved.resolved, `已由 ${params.decidedBy.label} 处理`].slice(-10);
            setResolved(saved.resolved); remember();
          }
        });
      } catch { if (!stopped) setError("Agent 服务暂不可达"); } finally {opening=false;}
    }
    void open();
    const retry = setInterval(() => { if (!unsubscribe) void open(); }, 2000);
    return () => { stopped = true; clearInterval(retry); unsubscribe?.(); };
  }, [nodeId, threadBound]);
  // A decision can land between the metadata GET and EventSource attach.
  // The terminal node transition reconciles its durable decision receipt.
  useEffect(() => {
    if (!threadBound || nodeStatus === "streaming") return;
    let stopped = false;
    void fetch(`/api/nodes/${nodeId}/as`).then(r => r.json()).then(value => {
      if (!stopped && value.resolved?.length) setResolved(value.resolved);
    }).catch(() => {});
    return () => { stopped = true; };
  }, [nodeId, nodeStatus, threadBound]);
  async function change(permission: string) {
    if (busy || !supported) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/nodes/${nodeId}/as`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({permission}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setThread(value.thread);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  if (!threadBound) return null;
  return <div data-as-project={nodeId} className="my-3 min-w-0 max-w-full space-y-2 text-sm [overflow-wrap:anywhere]">
    {thread && <p data-as-source className="text-muted">{thread.backend}{external ? " · 外部会话" : ""} · {thread.title ?? "Agent 会话"}{thread.status.type === "closed" ? " · 已结束" : ""}</p>}
    {notice && <p role="status" data-as-fallback>{notice}</p>}
    {thread && <label className="flex flex-wrap items-center gap-2">权限模式
      <select data-as-permission aria-label="权限模式" value={thread.permission ?? "default"} disabled={!supported || busy}
        onChange={e => void change(e.target.value)} onKeyDown={e => {
          if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); void change(modes[(modes.indexOf(thread.permission ?? "default") + 1) % modes.length]); }
        }} className="min-h-11 min-w-11 max-w-full rounded border border-border bg-surface px-3">
        {!modes.includes(thread.permission ?? "default") && <option value={thread.permission} disabled>{labels[thread.permission!] ?? thread.permission}</option>}
        {modes.map(mode => <option key={mode} value={mode}>{labels[mode]}</option>)}
      </select><span className="text-muted">Shift+Tab 切换</span>
    </label>}
    {resolved.map((message, i) => <p data-as-resolved key={i}>{message}</p>)}
    {thread && <details data-as-system-log className="max-w-full rounded border border-border p-2">
      <summary className="min-h-11 min-w-11 cursor-pointer py-3">系统日志（{logs.length}）</summary>
      <pre className="max-h-64 max-w-full overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{logs.join("\n") || "等待系统事件"}</pre>
    </details>}
    {error && <p role="alert" className="text-warn-ink">{error}</p>}
  </div>;
}
