"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import type { CleanItemPreview } from "@/app/api/workspaces/worktree/clean/route";

export type BatchCleanModalProps = {
  open: boolean;
  workspaceIds: string[];
  projectName?: string;
  onClose: () => void;
  onSuccess: () => void;
};

export function BatchCleanModal({
  open,
  workspaceIds,
  projectName,
  onClose,
  onSuccess,
}: BatchCleanModalProps) {
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [items, setItems] = useState<CleanItemPreview[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // 1. 请求预览
  useEffect(() => {
    if (!open || workspaceIds.length === 0) return;
    setLoading(true);
    setError(null);
    fetch("/api/workspaces/worktree/clean", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds, force: false }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setError(res.error);
        } else {
          const list: CleanItemPreview[] = res.items || [];
          setItems(list);
          // 默认选中所有可以安全删除的干净项（无 dirty、无 running）
          const safeIds = new Set(
            list.filter((it) => it.canClean && it.dirtyCount === 0).map((it) => it.id),
          );
          setSelectedIds(safeIds);
        }
      })
      .catch(() => setError("网络请求失败"))
      .finally(() => setLoading(false));
  }, [open, workspaceIds]);

  if (!open) return null;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === items.filter((it) => it.canClean).length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.filter((it) => it.canClean).map((it) => it.id)));
    }
  };

  // 2. 确认执行删除
  const handleClean = async () => {
    if (selectedIds.size === 0) return;
    setCleaning(true);
    setError(null);
    try {
      const r = await fetch("/api/workspaces/worktree/clean", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceIds: Array.from(selectedIds),
          force: true,
        }),
      }).then((x) => x.json());

      if (r.error) {
        setError(r.error);
      } else {
        onSuccess();
        onClose();
      }
    } catch {
      setError("批量清理失败，请重试");
    } finally {
      setCleaning(false);
    }
  };

  const totalSafe = items.filter((it) => it.canClean && it.dirtyCount === 0).length;

  return (
    <Modal onClose={onClose} size="md" panelClassName="max-h-[85vh] flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-ui text-ink-strong truncate">
            🧹 批量清理已合并工作区
          </span>
          {projectName && (
            <span className="text-nano text-ink-faint truncate">· {projectName}</span>
          )}
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      {/* Notice info */}
      <div className="px-4 py-2.5 bg-surface-muted/50 border-b border-line-faint text-nano text-ink-muted shrink-0 leading-relaxed">
        已合并到主干且无未提交修改的工作区可安全回收。清理将执行{" "}
        <code className="font-mono text-ink-faint">git worktree remove</code>{" "}
        并移除对应本地目录，释放磁盘空间。分支本身不受影响。
      </div>

      {/* Items list */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <div className="py-12 text-center text-ink-faint text-ui italic">
            正在预检可清理工作区…
          </div>
        ) : error ? (
          <div className="py-8 text-center text-danger text-ui">
            预检失败：{error}
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-ink-faint text-ui">
            暂无需要清理的工作区
          </div>
        ) : (
          <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex items-center justify-between text-nano pb-1 border-b border-line-faint">
              <label className="flex items-center gap-1.5 cursor-pointer text-ink font-medium select-none">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && selectedIds.size === items.filter((it) => it.canClean).length}
                  onChange={toggleSelectAll}
                  className="rounded border-line"
                />
                全选可清理项 ({selectedIds.size}/{totalSafe})
              </label>
              <span className="text-ink-faint tabular-nums">
                共 {items.length} 个候选工作区
              </span>
            </div>

            {/* List */}
            <div className="divide-y divide-line-faint border border-line rounded-md bg-surface-canvas overflow-hidden">
              {items.map((it) => {
                const checked = selectedIds.has(it.id);
                const isWarning = it.dirtyCount > 0 || it.ignoredCount > 0;
                return (
                  <div
                    key={it.id}
                    className={`px-3 py-2 flex items-center gap-2 text-nano transition-colors ${
                      it.canClean ? "hover:bg-surface-muted cursor-pointer" : "opacity-50"
                    }`}
                    onClick={() => it.canClean && toggleSelect(it.id)}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!it.canClean}
                      onChange={() => {}}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border-line shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink truncate">{it.name}</span>
                        {it.branch && it.branch !== it.name && (
                          <span className="text-nano font-mono text-ink-faint truncate max-w-40">
                            {it.branch}
                          </span>
                        )}
                        {!it.exists && (
                          <span className="text-nano px-1 rounded bg-surface-muted text-ink-faint">
                            目录已删除
                          </span>
                        )}
                      </div>
                      <div className="text-nano text-ink-faint font-mono truncate mt-0.5">
                        {it.path}
                      </div>
                    </div>
                    {isWarning && (
                      <span className="text-warn text-nano shrink-0 font-medium" title="存在未提交改动">
                        ● {it.dirtyCount} 改动
                      </span>
                    )}
                    {it.reason && (
                      <span className="text-danger text-nano shrink-0">{it.reason}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-2 shrink-0 bg-surface">
        <span className="text-nano text-ink-faint">
          已选择 {selectedIds.size} 个工作区
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={cleaning}>
            取消
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleClean}
            disabled={selectedIds.size === 0 || cleaning}
          >
            {cleaning ? "清理中…" : `确认清理 (${selectedIds.size})`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
