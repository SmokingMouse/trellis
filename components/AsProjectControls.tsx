"use client";
import { useEffect, useState } from "react";
import type { ThreadEvent } from "@/lib/as-thread-event";
import { useSessionStore } from "@/stores/sessionStore";
import type { Thread } from "@smokingmouse/agent-server/protocol";
import { isDebugEngineEvent, relativeEngineEventTime, restoreEngineEvents, summarizeEngineEvent, type AsEngineEvent } from "@/lib/as-engine-event-format";

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
  // 与 ToolTimeline 同一套卡片语言：一行表头（chevron · 标签 · 计数 · 来源 ·
  // 权限）+ 展开后的分隔线列表。折叠靠原生 <details>，手机验收脚本点的就是
  // `[data-as-system-log] > summary` 并读 `.open`，所以表头必须是它的直接子元素。
  // 提示行（fallback / 已处理 / 错误）在折叠态也要能读到，只能落在卡外。
  return <div data-as-project={nodeId} className="min-w-0 max-w-full [overflow-wrap:anywhere]">
    {thread && <details data-as-system-log className="group/log mb-3 border border-line rounded-card overflow-hidden bg-surface-muted/60">
      <summary className="px-3 py-2 flex items-center gap-2 text-ui cursor-pointer hover:bg-surface-muted transition-colors list-none [&::-webkit-details-marker]:hidden max-md:min-h-11">
        <span className="text-ink-faint transition-transform shrink-0 group-open/log:rotate-90" aria-hidden>▸</span>
        <span className="font-medium text-ink shrink-0">🔌 引擎</span>
        <span className="text-ink-muted tabular-nums shrink-0">{visibleLogs.length} 条事件</span>
        <span data-as-source className="flex-1 min-w-0 text-ink-faint truncate max-md:whitespace-normal max-md:line-clamp-2">
          {thread.backend}{external ? " · 外部会话" : ""} · {thread.title ?? "Agent 会话"}{thread.status.type === "closed" ? " · 已结束" : ""}
          {!showAll && debugCount > 0 ? ` · 已折叠 ${debugCount} 条调试事件` : ""}
        </span>
        <span className="text-nano text-ink-faint hidden sm:inline shrink-0">
          <span className="group-open/log:hidden">展开</span>
          <span className="hidden group-open/log:inline">收起</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-ink-muted">权限
          {external ? <>
            <span data-as-permission className="rounded-field border border-line bg-surface px-2 py-0.5 text-ink">{labels[thread.permission ?? "default"] ?? thread.permission}</span>
            <span className="text-ink-faint">只读</span>
          </> : <select data-as-permission aria-label="权限模式" title="Shift+Tab 切换权限模式"
            value={thread.permission ?? "default"} disabled={!supported || busy}
            onClick={e => e.preventDefault()}
            onChange={e => void change(e.target.value)} onKeyDown={e => {
              if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); void change(modes[(modes.indexOf(thread.permission ?? "default") + 1) % modes.length]); }
            }} className="max-w-full rounded-field border border-line bg-surface px-2 py-0 text-ui text-ink md:-my-0.5 max-md:min-h-11 max-md:min-w-11 max-md:px-3">
            {!modes.includes(thread.permission ?? "default") && <option value={thread.permission} disabled>{labels[thread.permission!] ?? thread.permission}</option>}
            {modes.map(mode => <option key={mode} value={mode}>{labels[mode]}</option>)}
          </select>}
        </span>
      </summary>
      <div className="border-t border-line divide-y divide-line/70">
        <label className="px-3 py-2 flex items-center gap-2 text-ui text-ink-muted cursor-pointer max-md:min-h-11">
          <input data-as-show-all type="checkbox" checked={showAll} onChange={e => {
            setShowAll(e.target.checked);
            try { localStorage.setItem("trellis-as-events-show-all", String(e.target.checked)); } catch {}
          }} />显示全部{debugCount > 0 ? `（含 ${debugCount} 条调试）` : ""}
        </label>
        <div className="max-h-64 max-w-full overflow-y-auto divide-y divide-line/70">
          {visibleLogs.map((log, i) => <details data-as-engine-event key={`${log.at}-${i}`} className="group/event">
            <summary className="px-3 py-2 flex items-center gap-2 text-ui cursor-pointer hover:bg-surface-muted transition-colors list-none [&::-webkit-details-marker]:hidden max-md:min-h-11">
              <span className="text-ink-muted tabular-nums shrink-0">{relativeEngineEventTime(log.at, now)}</span>
              <span className="font-mono text-nano text-ink-faint truncate shrink-0">{log.method}</span>
              <span className="flex-1 truncate min-w-0 text-ink">{summarizeEngineEvent(log.method, log.payload)}</span>
              <span className="text-ink-faint transition-transform shrink-0 group-open/event:rotate-90" aria-hidden>▸</span>
            </summary>
            <pre className="max-w-full whitespace-pre-wrap px-3 pb-2 text-nano text-ink-muted [overflow-wrap:anywhere]">{JSON.stringify(log.payload, null, 2)}</pre>
          </details>)}
          {!visibleLogs.length && <p className="px-3 py-2 text-ui text-ink-faint">{logs.length ? "暂无需要关注的引擎事件" : "等待引擎事件"}</p>}
        </div>
      </div>
    </details>}
    {(notice || error || resolved.length > 0) && <div className="mb-3 space-y-1 px-1 text-ui">
      {notice && <p role="status" data-as-fallback className="text-ink-muted">{notice}</p>}
      {resolved.map((message, i) => <p data-as-resolved key={i} className="text-ink-muted">{message}</p>)}
      {error && <p role="alert" className="text-warn-ink">{error}</p>}
    </div>}
  </div>;
}
