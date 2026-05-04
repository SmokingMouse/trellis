import type { ChatNode, Session } from "./types";

// ---------------------------------------------------------------------------
// `.trellis.json` schema — canonical, stable across versions.
// View-state (positions) is intentionally omitted; it's recomputed on load.
// ---------------------------------------------------------------------------

export const TRELLIS_FORMAT = "trellis" as const;
export const TRELLIS_VERSION = 1 as const;

export type TrellisNodeExport = {
  id: string;
  parentId: string | null;
  parentAnchor: { selectedText: string } | null;
  question: string;
  response: string;
  siblingIndex: number;
  createdAt: number;
  tokenCount: { input: number; output: number };
  status: ChatNode["status"];
  errorMessage?: string;
};

export type TrellisFile = {
  format: typeof TRELLIS_FORMAT;
  version: typeof TRELLIS_VERSION;
  exportedAt: number;
  session: {
    id: string;
    title: string;
    rootNodeId: string;
    createdAt: number;
    updatedAt: number;
  };
  nodes: TrellisNodeExport[];
};

export function exportJSON(session: Session, nodes: ChatNode[]): string {
  const file: TrellisFile = {
    format: TRELLIS_FORMAT,
    version: TRELLIS_VERSION,
    exportedAt: Date.now(),
    session: {
      id: session.id,
      title: session.title,
      rootNodeId: session.rootNodeId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      parentAnchor: n.parentAnchor,
      question: n.question,
      response: n.response,
      siblingIndex: n.siblingIndex,
      createdAt: n.createdAt,
      tokenCount: n.tokenCount,
      status: n.status,
      ...(n.errorMessage ? { errorMessage: n.errorMessage } : {}),
    })),
  };
  return JSON.stringify(file, null, 2);
}

// ---------------------------------------------------------------------------
// Markdown serialization — DFS over the tree, heading depth = tree depth (capped at h6).
// Renders cleanly in any markdown viewer including Feishu.
// ---------------------------------------------------------------------------

export function exportMarkdown(session: Session, nodes: ChatNode[]): string {
  const byParent = new Map<string | null, ChatNode[]>();
  for (const n of nodes) {
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }

  const root = nodes.find((n) => n.id === session.rootNodeId);
  if (!root) return "";

  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push("");
  lines.push(
    `> 导出于 ${new Date().toLocaleString("zh-CN")} · ${nodes.length} 个节点 · 创建于 ${new Date(session.createdAt).toLocaleDateString("zh-CN")}`,
  );
  lines.push("");

  const walk = (node: ChatNode, depth: number) => {
    const level = Math.min(2 + depth, 6);
    const hashes = "#".repeat(level);

    if (depth > 0) {
      lines.push("---");
      lines.push("");
    }

    lines.push(`${hashes} ${depth > 0 ? "↳ " : ""}${node.question}`);
    lines.push("");

    if (node.parentAnchor?.selectedText) {
      lines.push(`> 从「${node.parentAnchor.selectedText}」分叉`);
      lines.push("");
    }

    if (node.response) {
      lines.push(node.response);
      lines.push("");
    }

    const children = byParent.get(node.id) ?? [];
    for (const c of children) walk(c, depth + 1);
  };

  walk(root, 0);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Browser download helper.
// ---------------------------------------------------------------------------

export function downloadFile(
  filename: string,
  content: string,
  mime: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "trellis";
}
