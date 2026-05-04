"use client";
import { useEffect, useState } from "react";

export type SelectionInfo = {
  text: string;
  rect: DOMRect;
  nodeId: string;
};

// Watches the document for text selections inside elements marked with
// data-chat-node-id. Returns the selection info, or null when nothing is
// selected (or selection is outside any chat node).
export function useSelectionWithin(): SelectionInfo | null {
  const [info, setInfo] = useState<SelectionInfo | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const compute = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setInfo(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setInfo(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : (container as Element);
      const nodeEl = el?.closest("[data-chat-node-id]");
      if (!nodeEl) {
        setInfo(null);
        return;
      }
      const nodeId = nodeEl.getAttribute("data-chat-node-id");
      if (!nodeId) {
        setInfo(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // Some Ranges over wrapped lines return zero-rects on the first call.
      // Skip those — selectionchange will fire again with a real rect.
      if (rect.width === 0 && rect.height === 0) return;
      setInfo({ text, rect, nodeId });
    };
    const handler = () => {
      // Coalesce rapid selectionchange events
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(compute, 30);
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      document.removeEventListener("selectionchange", handler);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return info;
}
