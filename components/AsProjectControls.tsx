"use client";
import { useEffect, useState } from "react";
import type { ShadowEvent } from "@/lib/as-shadow";
import { useSessionStore } from "@/stores/sessionStore";

const modes = ["default", "acceptEdits", "plan", "dontAsk"];
const labels: Record<string,string> = { default: "逐次确认", acceptEdits: "允许编辑", plan: "计划模式", dontAsk: "不询问", full: "绕过审批", bypassPermissions: "绕过审批" };
export function AsProjectControls({ nodeId }: { nodeId: string }) {
  const threadBound = useSessionStore(s => s.session?.bindingType === "thread");
  const [thread, setThread] = useState<{id:string; permission?:string} | null>(null);
  const [supported, setSupported] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notice = useSessionStore(s => s.nodes[nodeId]?.asNotice);
  useEffect(() => {
    if (!threadBound) return;
    let stopped = false, source: EventSource | undefined;
    const key = `trellis-as-ui:${nodeId}`;
    let saved: {logs:string[]; resolved:string[]} = { logs: [], resolved: [] };
    try { saved = JSON.parse(sessionStorage.getItem(key) ?? JSON.stringify(saved)); } catch {}
    setLogs(saved.logs); setResolved(saved.resolved);
    const remember = () => { try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch {} };
    async function open() {
      try {
        const response = await fetch(`/api/nodes/${nodeId}/as`);
        const value = await response.json();
        if (stopped) return;
        if (!response.ok) { setError("Agent 服务暂不可达"); return; }
        if (!value.thread) return;
        setThread(value.thread); setSupported(value.permissionSet); setError("");
        if (value.resolved?.length) { saved.resolved = value.resolved; setResolved(saved.resolved); remember(); }
        source = new EventSource(`/api/as/threads/${value.thread.id}/stream`);
        source.onmessage = event => {
          const data = JSON.parse(event.data) as ShadowEvent;
          if (data.type === "snapshot") { setThread(data.snapshot.thread); return; }
          if (data.type !== "notification") return;
          const { method, params } = data.notification;
          if (method === "thread/permission/changed") setThread(t => t ? { ...t, permission: params.permission } : t);
          if (method === "thread/engineEvent" && (!params.turnId || params.turnId === value.turnId)) {
            saved.logs = [...saved.logs, `${params.subtype}: ${JSON.stringify(params.payload)}`].slice(-100);
            setLogs(saved.logs); remember();
          }
          if (method === "serverRequest/resolved") {
            saved.resolved = [...saved.resolved, `已由 ${params.decidedBy.label} 处理`].slice(-10);
            setResolved(saved.resolved); remember();
          }
        };
      } catch { if (!stopped) setError("Agent 服务暂不可达"); }
    }
    void open();
    const retry = setInterval(() => { if (!source) void open(); }, 2000);
    return () => { stopped = true; clearInterval(retry); source?.close(); };
  }, [nodeId, threadBound]);
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
