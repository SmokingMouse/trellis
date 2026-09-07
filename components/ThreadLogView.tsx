"use client";

import { useEffect, useRef, useState } from "react";
import type { ShadowEvent } from "@/lib/as-shadow";
import { applyShadowEvent, emptyThreadLog, itemText } from "@/lib/as-log";

const labels: Record<string, string> = {
  userMessage: "输入", agentMessage: "回复", reasoning: "思考",
  commandExecution: "命令", fileChange: "文件改动", toolCall: "工具",
  mcpToolCall: "MCP", subAgent: "子任务", error: "错误",
};
const states: Record<string, string> = { connected: "实时连接", connecting: "连接中", disconnected: "连接中断", reconnecting: "正在重连", closed: "连接关闭" };

export function ThreadLogView({ threadId }: { threadId: string }) {
  const [log, setLog] = useState(emptyThreadLog);
  const current = useRef(log);
  const [paused, setPaused] = useState(false);
  const section = useRef<HTMLElement>(null);
  const following = useRef(true);
  const [followTail, setFollowTail] = useState(true);
  const scrollBottom = () => {
    const container = section.current?.closest<HTMLElement>(".as-shadow");
    if (container) container.scrollTop = container.scrollHeight;
  };
  useEffect(() => {
    const container = section.current?.closest<HTMLElement>(".as-shadow");
    if (!container) return;
    let previousTop = container.scrollTop;
    const onScroll = () => {
      if (container.scrollTop < previousTop - 1) following.current = false;
      else if (container.scrollTop > previousTop && container.scrollHeight - container.clientHeight - container.scrollTop <= 48) following.current = true;
      previousTop = container.scrollTop;
      setFollowTail(following.current);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
    };
  }, []);
  useEffect(() => {
    if (!following.current) return;
    const frame = requestAnimationFrame(() => { if (following.current) scrollBottom(); });
    return () => cancelAnimationFrame(frame);
  }, [log]);
  useEffect(() => {
    if (paused) return;
    const source = new EventSource(`/api/as/threads/${encodeURIComponent(threadId)}/stream?sinceSeq=${current.current.cursor}`);
    const update = (event: ShadowEvent) => {
      current.current = applyShadowEvent(current.current, event);
      setLog(current.current);
    };
    source.onmessage = event => {
      try { update(JSON.parse(event.data) as ShadowEvent); }
      catch { update({ type: "connection", state: "disconnected" }); }
    };
    source.onopen = () => update({ type: "connection", state: "connected" });
    source.onerror = () => update({ type: "connection", state: "reconnecting" });
    return () => source.close();
  }, [threadId, paused]);

  const items = Object.values(log.items).sort((a, b) => a.seq - b.seq);
  return <section ref={section} className="as-log" aria-label="会话日志" data-as-log data-cursor={log.cursor} data-follow-tail={followTail}>
    <div className="as-log-toolbar">
      <div><span className={`as-dot ${!paused && log.state === "connected" ? "as-online" : ""}`} />
        <span role="status">{paused ? "已暂停查看" : states[log.state] ?? log.state}</span>
        <small> · {items.length} 条日志</small>
      </div>
      <button type="button" data-as-pause onClick={() => setPaused(value => !value)}>{paused ? "继续查看" : "暂停查看"}</button>
    </div>
    {log.errors.map((error, index) => <aside className="as-approval" role="alert" data-as-error key={index}>
      <strong>服务错误 · {error.error.code}</strong>
      <p>{error.error.message}</p>
      <small>{error.willRetry ? "服务将重试" : "请在原客户端检查"}</small>
    </aside>)}
    {Object.values(log.turns).sort((a, b) => a.ordinal - b.ordinal).map(turn => <p key={turn.id} data-as-turn={turn.id} data-turn-status={turn.status} className="as-turn-status">
      第 {turn.ordinal} 轮 · {turn.status === "inProgress" ? "进行中" : turn.status === "completed" ? "已完成" : turn.status === "failed" ? "失败" : turn.status === "interrupted" ? "已中断" : turn.status}
      {turn.error && ` · ${turn.error.message}`}
    </p>)}
    {log.pending.map(request => <aside className="as-approval" key={request.requestId} data-as-approval>
      <strong>等待审批 · 只读</strong>
      <p>请在原客户端处理此请求。</p>
      <pre>{JSON.stringify(request, null, 2)}</pre>
    </aside>)}
    {!items.length && <p className="as-empty">等待这段会话的第一条日志。</p>}
    <ol className="as-items">
      {items.map(item => <li key={item.id} data-as-item={item.id} data-item-type={item.type} data-item-status={item.status}>
        <div className="as-item-heading"><span>{labels[item.type] ?? item.type}</span><small>#{item.seq} · {item.status === "inProgress" ? "进行中" : item.status === "rejected" ? "已拒绝" : item.status === "failed" ? "失败" : "完成"}</small></div>
        <pre>{itemText(item)}</pre>
      </li>)}
    </ol>
    {!followTail && <button type="button" className="as-follow" data-as-follow onClick={() => {
      following.current = true;
      setFollowTail(true);
      scrollBottom();
    }}>回到底部 ↓</button>}
  </section>;
}
