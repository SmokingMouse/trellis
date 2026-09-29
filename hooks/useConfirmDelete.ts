"use client";
import { useCallback } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { subtreeIds } from "@/lib/collapsed";
import { toast, useConfirm } from "@/components/ui";
import { deleteWithUndo } from "@/lib/undoable";

// Returns a single click-handler-friendly function: pass it a nodeId and
// it asks for confirmation with the cascade preview ("N 个节点 + M 条笔记"),
// then dispatches the optimistic store action. Centralised so every delete
// entry (Outline row / canvas card chip / SubBar) prompts with the same
// wording and the same set of refusal cases (session root, streaming).
//
// W4：原生 confirm / alert 换成 ConfirmDialog + toast。
// 确认后先本地摘掉，6 秒内 toast 上可「撤销」，窗口结束才真发 DELETE。
export function useConfirmDelete(): (nodeId: string) => void {
  const stageDeleteNode = useSessionStore((s) => s.stageDeleteNode);
  const confirm = useConfirm();
  return useCallback(
    (nodeId: string) => {
      const s = useSessionStore.getState();
      const node = s.nodes[nodeId];
      if (!node) return;
      if (s.session?.rootNodeId === nodeId) {
        toast.info("会话的第一个节点不能单独删除", {
          description: "要删掉整段对话，请在侧栏用「删除会话」。",
        });
        return;
      }
      if (node.status === "streaming") {
        toast.info("这个节点还在生成", { description: "先按 Esc 中止，再删除。" });
        return;
      }
      const ids = subtreeIds(nodeId, s.nodes);
      const idSet = new Set(ids);
      const noteCount = s.notes.filter((n) => idSet.has(n.sourceNodeId)).length;
      const title = ids.length === 1 ? "删除这个节点？" : `删除整棵子树（${ids.length} 个节点）？`;
      const description =
        ids.length === 1
          ? `${noteCount ? `它的 ${noteCount} 条笔记会一起删除。` : ""}删除后几秒内可以撤销。`
          : `从这里往下的所有追问和回答${noteCount ? `，以及 ${noteCount} 条笔记` : ""}都会删除。删除后几秒内可以撤销。`;
      void (async () => {
        if (!(await confirm({ title, description, confirmLabel: "删除", danger: true }))) return;
        const staged = stageDeleteNode(nodeId);
        if (!staged) return;
        deleteWithUndo({
          title:
            staged.nodeCount === 1 ? "已删除节点" : `已删除 ${staged.nodeCount} 个节点`,
          commit: staged.commit,
          undo: staged.undo,
        });
      })();
    },
    [stageDeleteNode, confirm],
  );
}
