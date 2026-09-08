"use client";
import { useEffect, useState } from "react";
import type { ShadowEvent } from "@/lib/as-shadow";
import { useSessionStore } from "@/stores/sessionStore";
import type { Thread } from "@smokingmouse/agent-server/protocol";
import { isDebugEngineEvent, relativeEngineEventTime, restoreEngineEvents, summarizeEngineEvent, type AsEngineEvent } from "@/lib/as-engine-event-format";

const modes = ["default", "acceptEdits", "plan", "dontAsk"];
const labels: Record<string,string> = { default: "逐次确认", acceptEdits: "允许编辑", plan: "计划模式", dontAsk: "不询问", full: "绕过审批", bypassPermissions: "绕过审批" };
const observers = new Map<string, {source:EventSource; listeners:Set<(event:ShadowEvent)=>void>; snapshot?:ShadowEvent}>();
function observeThread(threadId:string, listener:(event:ShadowEvent)=>void) {
  let observer=observers.get(threadId);
  if (!observer) {
    observer={source:new EventSource(`/api/as/threads/${threadId}/stream`),listeners:new Set()};
    observers.set(threadId,observer);
    const active=observer;
    active.source.onmessage=event=>{
      const data=JSON.parse(event.data) as ShadowEvent;
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
  const [logs, setLogs] = useState<AsEngineEvent[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    try { setShowAll(localStorage.getItem("trellis-as-events-show-all") === "true"); } catch {}
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const [resolved, setResolved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notice = useSessionStore(s => s.nodes[nodeId]?.asNotice);
  useEffect(() => {
    if (!threadBound) return;
    let stopped = false, opening = false, unsubscribe: (()=>void) | undefined;
    const pendingIds = new Set<string>();
    const key = `trellis-as-ui:${nodeId}`;
    const saved: {logs:AsEngineEvent[]; resolved:string[]} = { logs: [], resolved: [] };
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      saved.logs = restoreEngineEvents(value.logs);
      saved.resolved = Array.isArray(value.resolved) ? value.resolved.filter((v: unknown) => typeof v === "string").slice(-10) : [];
    } catch {}
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
        unsubscribe = observeThread(value.thread.id, data => {
          if (data.type === "snapshot") {
            setThread(data.snapshot.thread);
            pendingIds.clear();
            for (const request of data.snapshot.pendingRequests) if (request.params.turnId === value.turnId) pendingIds.add(request.params.requestId);
            return;
          }
          if (data.type !== "notification") return;
          const { method, params } = data.notification;
          if (method === "thread/pendingRequests" && params.turnId === value.turnId && params.status === "pending") pendingIds.add(params.requestId);
          if (method === "thread/permission/changed") {
            setThread(t => t ? { ...t, permission: params.permission } : t);
            saved.logs = [...saved.logs, { method, payload: params, at: Date.now() }].slice(-100);
            setLogs(saved.logs); remember();
          }
          if (method === "thread/status/changed") setThread(t => t ? {...t,status:params.status} : t);
          if (method === "thread/closed") setThread(t => t ? {...t,status:{type:"closed"}} : t);
          if (method === "thread/engineEvent" && (!params.turnId || params.turnId === value.turnId)) {
            saved.logs = [...saved.logs, { method: params.subtype, payload: params.payload, at: Date.now() }].slice(-100);
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
    if (external || busy || !supported) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/nodes/${nodeId}/as`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({permission}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setThread(value.thread);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  if (!threadBound) return null;
  const debugCount = logs.filter(log => isDebugEngineEvent(log.method, log.payload)).length;
  const visibleLogs = showAll ? logs : logs.filter(log => !isDebugEngineEvent(log.method, log.payload));
  return <div data-as-project={nodeId} className="my-3 min-w-0 max-w-full space-y-2 text-sm [overflow-wrap:anywhere]">
    {thread && <p data-as-source className="text-muted">{thread.backend}{external ? " · 外部会话" : ""} · {thread.title ?? "Agent 会话"}{thread.status.type === "closed" ? " · 已结束" : ""}</p>}
    {notice && <p role="status" data-as-fallback>{notice}</p>}
    {thread && (external ? <p className="flex flex-wrap items-center gap-2">权限模式
      <span data-as-permission className="rounded border border-border bg-surface px-2 py-1">{labels[thread.permission ?? "default"] ?? thread.permission}</span>
      <span className="text-muted">只读</span>
    </p> : <label className="flex flex-wrap items-center gap-2">权限模式
      <select data-as-permission aria-label="权限模式" value={thread.permission ?? "default"} disabled={!supported || busy}
        onChange={e => void change(e.target.value)} onKeyDown={e => {
          if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); void change(modes[(modes.indexOf(thread.permission ?? "default") + 1) % modes.length]); }
        }} className="min-h-11 min-w-11 max-w-full rounded border border-border bg-surface px-3">
        {!modes.includes(thread.permission ?? "default") && <option value={thread.permission} disabled>{labels[thread.permission!] ?? thread.permission}</option>}
        {modes.map(mode => <option key={mode} value={mode}>{labels[mode]}</option>)}
      </select><span className="text-muted">Shift+Tab 切换</span>
    </label>)}
    {resolved.map((message, i) => <p data-as-resolved key={i}>{message}</p>)}
    {thread && <details data-as-system-log className="max-w-full rounded border border-border p-2">
      <summary className="min-h-11 min-w-11 cursor-pointer py-3">引擎事件（{visibleLogs.length}）{!showAll && debugCount > 0 && <span className="ml-2 text-muted">已折叠 {debugCount} 条调试事件</span>}</summary>
      <label className="flex min-h-11 cursor-pointer items-center gap-2">
        <input data-as-show-all type="checkbox" checked={showAll} onChange={e => {
          setShowAll(e.target.checked);
          try { localStorage.setItem("trellis-as-events-show-all", String(e.target.checked)); } catch {}
        }} />显示全部
      </label>
      <div className="max-h-64 max-w-full space-y-1 overflow-y-auto">
        {visibleLogs.map((log, i) => <details data-as-engine-event key={`${log.at}-${i}`} className="rounded border border-border px-2">
          <summary className="min-h-11 cursor-pointer py-3">
            <span className="mr-2 text-muted">{relativeEngineEventTime(log.at, now)}</span>
            <span className="mr-2 font-mono text-xs text-muted">{log.method}</span>
            <span>{summarizeEngineEvent(log.method, log.payload)}</span>
          </summary>
          <pre className="max-w-full whitespace-pre-wrap pb-2 text-xs [overflow-wrap:anywhere]">{JSON.stringify(log.payload, null, 2)}</pre>
        </details>)}
        {!visibleLogs.length && <p className="py-2 text-muted">{logs.length ? "暂无需要关注的引擎事件" : "等待引擎事件"}</p>}
      </div>
    </details>}
    {error && <p role="alert" className="text-warn-ink">{error}</p>}
  </div>;
}
