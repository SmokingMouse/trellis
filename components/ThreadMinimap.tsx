"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { layoutNodes } from "@/lib/layout";
import { buildNodeIndex } from "@/lib/node-index";
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

// Markdown → plain-text excerpt for the hover preview card. Lossy on purpose:
// code blocks and images carry no scannable signal at this size, so they drop.
function excerpt(md: string, max: number) {
  const text = md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function ThreadMinimap() {
  const nodesMap = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const [collapsed, setCollapsed] = useState(false);
  // Hovered/focused dot → preview card floating left of the panel, vertically
  // centered on the dot (y is the dot's SVG-space center, clamped below).
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null);

  const nodes = useMemo(
    () => Object.values(nodesMap).sort(nodeSort),
    [nodesMap],
  );
  const nodeIndices = useMemo(() => buildNodeIndex(nodesMap), [nodesMap]);
  const activeId = activeNodeId && nodesMap[activeNodeId] ? activeNodeId : nodes[0]?.id;
  // Guard against the hovered node being deleted out from under the card.
  const hoverNode = hover ? (nodesMap[hover.id] ?? null) : null;

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
      <div className="rounded-card border border-line/80 bg-surface/90 shadow-pop backdrop-blur">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full px-3 py-2 flex items-center justify-between gap-3 text-ink-muted hover:bg-surface-muted rounded-t-card"
          title={collapsed ? "展开树缩略图" : "收起树缩略图"}
        >
          <span className="font-medium">树</span>
          <span className="text-ink-faint tabular-nums">
            {collapsed ? "▴" : `${nodes.length} · ▾`}
          </span>
        </button>
        {!collapsed && geometry && (
          <div className="relative">
          <svg
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            className="block border-t border-line-faint"
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
                  className="stroke-line-strong"
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
                  onMouseEnter={() => setHover({ id: n.id, y: p.y })}
                  onMouseLeave={() =>
                    setHover((h) => (h?.id === n.id ? null : h))
                  }
                  onFocus={() => setHover({ id: n.id, y: p.y })}
                  onBlur={() =>
                    setHover((h) => (h?.id === n.id ? null : h))
                  }
                  className="cursor-pointer outline-none"
                >
                  {/* invisible enlarged hit target — the visible dot alone is
                      too small to hover/click reliably */}
                  <circle cx={p.x} cy={p.y} r={9} fill="transparent" />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isActive ? 5 : 3.5}
                    className={
                      isActive
                        ? "fill-accent stroke-surface"
                        : isUnread
                          ? "fill-unread stroke-surface"
                          : "fill-ink-faint stroke-surface"
                    }
                    strokeWidth={isActive ? 2 : 1.5}
                  />
                </g>
              );
            })}
          </svg>
          {hoverNode && hover && (
            <div
              className="pointer-events-none absolute right-full mr-2 w-64 rounded-card border border-line bg-surface shadow-pop px-3 py-2.5 text-left"
              style={{
                top: Math.min(Math.max(hover.y, 40), SVG_H - 40),
                transform: "translateY(-50%)",
              }}
              aria-hidden
            >
              <div className="text-label text-ink-faint font-mono">
                #{nodeIndices[hoverNode.id] ?? "?"} ·{" "}
                {hoverNode.kind === "reference" ? "Reference" : "Turn"}
              </div>
              <div className="mt-1 text-xs font-semibold text-ink-strong line-clamp-2">
                {hoverNode.topicLabel ?? excerpt(hoverNode.question, 80)}
              </div>
              {(() => {
                const body =
                  hoverNode.status === "error"
                    ? "生成失败"
                    : excerpt(hoverNode.response, 160) ||
                      (hoverNode.status === "streaming" ? "生成中…" : "");
                return body ? (
                  <div className="mt-1 text-xs leading-relaxed text-ink-muted line-clamp-4">
                    {body}
                  </div>
                ) : null;
              })()}
            </div>
          )}
          </div>
        )}
      </div>
    </div>
  );
}
