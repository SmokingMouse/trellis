"use client";
import { useCallback } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { subtreeIds } from "@/lib/collapsed";

// Returns a single click-handler-friendly function: pass it a nodeId and
// it shows a native confirm with the cascade preview ("delete N nodes +
// M notes"), then dispatches the optimistic store action. Centralised so
// every delete entry (Outline row / canvas card chip / SubBar) prompts
// with the same wording and the same set of refusal cases (session
// root, streaming).
export function useConfirmDelete(): (nodeId: string) => void {
  const deleteNode = useSessionStore((s) => s.deleteNode);
  return useCallback(
    (nodeId: string) => {
      const s = useSessionStore.getState();
      const node = s.nodes[nodeId];
      if (!node) return;
      if (s.session?.rootNodeId === nodeId) {
        window.alert("会话主根不能单独删除，请用「删除会话」");
        return;
      }
      if (node.status === "streaming") {
        window.alert("节点流式生成中，请先按 Esc 中止再删除");
        return;
      }
      const ids = subtreeIds(nodeId, s.nodes);
      const idSet = new Set(ids);
      const noteCount = s.notes.filter((n) => idSet.has(n.sourceNodeId)).length;
      const desc =
        ids.length === 1
          ? "删除这个节点？"
          : `删除整棵子树（${ids.length} 个节点${
              noteCount ? ` + ${noteCount} 条笔记` : ""
            }）？`;
      if (!window.confirm(`${desc}\n此操作不可撤销。`)) return;
      deleteNode(nodeId).catch((err) => {
        window.alert(
          "删除失败：" +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    },
    [deleteNode],
  );
}
