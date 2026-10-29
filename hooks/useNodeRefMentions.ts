"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { findMentionQuery, type NodeRef } from "@/lib/node-refs";

// `@` 引用其他会话 / 节点的补全（lib/node-refs.ts）。与 useAgentMentions 并存：
//   - 输入框末尾在打 `@查询`（行首或空白后的 @）就出「会话」候选；
//   - 整个输入就是 `@查询` 时 Agent 提及（useAgentMentions）也命中，两组同屏，
//     Agent 在上（老行为不变），会话在下；
//   - 句中 `… @查询` 只出会话（Agent 定向只认开头）。
// 会话行默认引用该会话最新一个已完成节点；点行尾的展开钮列出全部已完成节点改选。
// 候选走 /api/node-refs（服务端按最近活跃 + 标题 / topic 模糊 + 全文补充）。

export type RefCandidateNode = {
  nodeId: string;
  index: number;
  question: string;
  topicLabel: string | null;
  createdAt: number;
};

export type RefCandidateSession = {
  sessionId: string;
  title: string;
  updatedAt: number;
  mode: string;
  latest: RefCandidateNode | null;
};

/** 下拉里的一行：会话（选中 = 引用最新节点）或展开后的具体节点。 */
export type RefPickItem =
  | { kind: "session"; session: RefCandidateSession }
  | { kind: "node"; session: RefCandidateSession; node: RefCandidateNode };

export function refFromItem(item: RefPickItem): NodeRef | null {
  const node = item.kind === "node" ? item.node : item.session.latest;
  if (!node) return null;
  return {
    sessionId: item.session.sessionId,
    nodeId: node.nodeId,
    title: item.session.title,
    index: node.index,
  };
}

const DEBOUNCE_MS = 150;

export function useNodeRefMentions(text: string, enabled: boolean) {
  const mention = enabled ? findMentionQuery(text) : null;
  const query = mention?.query ?? null;
  const [results, setResults] = useState<{ query: string; sessions: RefCandidateSession[] } | null>(null);
  const [expanded, setExpanded] = useState<{ sessionId: string; nodes: RefCandidateNode[] | null } | null>(null);

  useEffect(() => {
    if (query === null) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/node-refs?q=${encodeURIComponent(query)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { sessions: [] }))
        .then((d: { sessions?: RefCandidateSession[] }) => setResults({ query, sessions: d.sessions ?? [] }))
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const expandedId = expanded?.sessionId ?? null;
  const toggleExpand = useCallback(
    (sessionId: string) => {
      if (expandedId === sessionId) {
        setExpanded(null);
        return;
      }
      setExpanded({ sessionId, nodes: null });
      fetch(`/api/node-refs?sessionId=${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? r.json() : { nodes: [] }))
        .then((d: { nodes?: RefCandidateNode[] }) =>
          setExpanded((now) => (now?.sessionId === sessionId ? { sessionId, nodes: d.nodes ?? [] } : now)),
        )
        .catch(() => {});
    },
    [expandedId],
  );

  const collapse = useCallback(() => setExpanded(null), []);

  // 查询变了还在等新结果时沿用上一批（避免列表闪空）；面板关掉后不显示旧结果。
  const sessions = useMemo(
    () => (query === null ? [] : (results?.sessions ?? [])),
    [query, results],
  );

  const items = useMemo<RefPickItem[]>(() => {
    const out: RefPickItem[] = [];
    for (const s of sessions) {
      out.push({ kind: "session", session: s });
      if (expanded?.sessionId === s.sessionId && expanded.nodes) {
        for (const n of expanded.nodes) out.push({ kind: "node", session: s, node: n });
      }
    }
    return out;
  }, [sessions, expanded]);

  return {
    /** 末尾是否正在打 `@查询` */
    active: query !== null,
    /** 整个输入就是 `@查询`（Agent 提及也参与） */
    atStart: mention?.atStart ?? false,
    query,
    items,
    expandedId,
    expandedLoading: !!expanded && expanded.nodes === null,
    toggleExpand,
    collapse,
  };
}
