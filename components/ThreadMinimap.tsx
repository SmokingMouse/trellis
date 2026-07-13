"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { layoutNodes } from "@/lib/layout";
import type { ChatNode } from "@/lib/types";

const NODE_W = 280;
const NODE_H = 90;
const SVG_W = 210;
const SVG_H = 250;
const PAD = 14;

function nodeSort(a: ChatNode, b: ChatNode) {
  return (
    a.createdAt - b.createdAt ||
    a.siblingIndex - b.siblingIndex ||
    a.id.localeCompare(b.id)
  );
}

export function ThreadMinimap() {
  const nodesMap = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const [collapsed, setCollapsed] = useState(false);

  const nodes = useMemo(
    () => Object.values(nodesMap).sort(nodeSort),
    [nodesMap],
  );
  const activeId = activeNodeId && nodesMap[activeNodeId] ? activeNodeId : nodes[0]?.id;

  const geometry = useMemo(() => {
    if (nodes.length === 0) return null;
    const laidOut = layoutNodes(nodes, undefined, { compact: true });
    const centers = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      const pos = laidOut.get(n.id);
      if (!pos) continue;
      centers.set(n.id, { x: pos.x + NODE_W / 2, y: pos.y + NODE_H / 2 });
    }
    if (centers.size === 0) return null;

    const xs = [...centers.values()].map((p) => p.x);
    const ys = [...centers.values()].map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const scale = Math.min(
      (SVG_W - PAD * 2) / Math.max(1, maxX - minX),
      (SVG_H - PAD * 2) / Math.max(1, maxY - minY),
      1,
    );
    const project = (p: { x: number; y: number }) => ({
      x: PAD + (p.x - minX) * scale,
      y: PAD + (p.y - minY) * scale,
    });
    const points = new Map<string, { x: number; y: number }>();
    for (const [id, p] of centers) points.set(id, project(p));
    return { points };
  }, [nodes]);

  if (nodes.length === 0) return null;

  return (
    <div className="fixed right-3 bottom-24 z-40 text-xs">
      <div className="rounded-lg border border-stone-200/80 dark:border-stone-700 bg-white/90 dark:bg-stone-950/90 shadow-lg backdrop-blur">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full px-3 py-2 flex items-center justify-between gap-3 text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-900 rounded-t-lg"
          title={collapsed ? "展开树缩略图" : "收起树缩略图"}
        >
          <span className="font-medium">树</span>
          <span className="text-stone-400 dark:text-stone-500 tabular-nums">
            {collapsed ? "▴" : `${nodes.length} · ▾`}
          </span>
        </button>
        {!collapsed && geometry && (
          <svg
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            className="block border-t border-stone-100 dark:border-stone-800"
            aria-label="线程树缩略图"
          >
            {nodes.map((n) => {
              if (!n.parentId) return null;
              const a = geometry.points.get(n.parentId);
              const b = geometry.points.get(n.id);
              if (!a || !b) return null;
              return (
                <line
                  key={`edge-${n.id}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="stroke-stone-300 dark:stroke-stone-700"
                  strokeWidth="1"
                />
              );
            })}
            {nodes.map((n) => {
              const p = geometry.points.get(n.id);
              if (!p) return null;
              const isActive = n.id === activeId;
              const isUnread = n.status === "done" && !n.readAt;
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={n.topicLabel ?? n.question}
                  onClick={() => setActiveNode(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveNode(n.id);
                    }
                  }}
                  className="cursor-pointer outline-none"
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isActive ? 5 : 3.5}
                    className={
                      isActive
                        ? "fill-indigo-500 stroke-white dark:stroke-stone-950"
                        : isUnread
                          ? "fill-amber-400 stroke-white dark:stroke-stone-950"
                          : "fill-stone-400 dark:fill-stone-500 stroke-white dark:stroke-stone-950"
                    }
                    strokeWidth={isActive ? 2 : 1.5}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
