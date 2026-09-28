"use client";
import { useEffect, useState } from "react";
import { FolderCheck, X } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Modal,
  SkeletonText,
  toast,
} from "@/components/ui";
import type { CleanItemPreview } from "@/app/api/workspaces/worktree/clean/route";

export type BatchCleanModalProps = {
  open: boolean;
  workspaceIds: string[];
  projectName?: string;
  onClose: () => void;
  onSuccess: () => void;
};

function isRecommended(item: CleanItemPreview): boolean {
  return (
    item.canClean &&
    item.dirtyCount === 0 &&
    item.ignoredCount === 0 &&
    item.sessionCount === 0
  );
}

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
  const [error, setError] = useState<unknown>(null);
  const [cleanError, setCleanError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
          // 会话和本地改动都需要用户逐项确认；默认只选零会话的干净项。
          const safeIds = new Set<string>(
            list.filter(isRecommended).map((it) => it.id),
          );
          setSelectedIds(safeIds);
        }
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [open, workspaceIds, reloadKey]);

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
    const recommended = items.filter(isRecommended);
    if (
      recommended.length > 0 &&
      recommended.every((item) => selectedIds.has(item.id))
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(recommended.map((it) => it.id)));
    }
  };

  // 2. 确认执行删除
  const handleClean = async () => {
    if (selectedIds.size === 0) return;
    setCleaning(true);
    setCleanError(null);
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
        setCleanError(r.error);
      } else {
        const failed: Array<{ name: string; error: string }> = r.errors ?? [];
        if (failed.length > 0) {
          toast.warning(`清理了 ${r.removedCount ?? 0} 个工作区，${failed.length} 个没清掉`, {
            description: failed.map((f) => `${f.name}：${f.error}`).join("\n"),
            duration: 10000,
          });
        } else {
          toast.success(`已清理 ${r.removedCount ?? selectedIds.size} 个工作区`);
        }
        onSuccess();
        onClose();
      }
    } catch (e) {
      setCleanError(e);
    } finally {
      setCleaning(false);
    }
  };

  const totalSafe = items.filter(isRecommended).length;

  const recommended = items.filter(isRecommended);
  const allChecked = totalSafe > 0 && recommended.every((it) => selectedIds.has(it.id));
  const someChecked = !allChecked && recommended.some((it) => selectedIds.has(it.id));

  return (
    <Modal
      onClose={onClose}
      size="md"
      title="批量清理已合并工作区"
      panelClassName="max-h-[85vh] flex flex-col"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="font-semibold text-ui text-ink-strong truncate">
            批量清理已合并工作区
          </h2>
          {projectName && (
            <span className="text-label text-ink-faint truncate">{projectName}</span>
          )}
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          <Icon icon={X} />
        </IconButton>
      </div>

      {/* Notice info */}
      <div className="px-4 py-2.5 bg-surface-muted border-b border-line-faint text-label text-ink-muted shrink-0 leading-relaxed">
        已合并到主干、且没有未提交修改的工作区可以安全回收：清理会删除对应的本地目录（
        <code className="font-mono text-ink-faint">git worktree remove</code>
        ），释放磁盘空间，分支本身保留。
      </div>

      {/* Items list */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <SkeletonText lines={4} className="py-2" />
        ) : error ? (
          <ErrorCallout
            error={error}
            title="检查可清理的工作区失败"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon={FolderCheck}
            title="没有需要清理的工作区"
            description="已合并的工作区都已回收。"
          />
        ) : (
          <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex items-center justify-between text-label pb-2 border-b border-line-faint">
              <label className="flex items-center gap-2 cursor-pointer text-ink font-medium select-none">
                <Checkbox
                  checked={allChecked ? true : someChecked ? "indeterminate" : false}
                  onCheckedChange={toggleSelectAll}
                  disabled={totalSafe === 0}
                />
                全选建议清理项（{selectedIds.size}/{totalSafe}）
              </label>
              <span className="text-ink-faint tabular-nums">
                共 {items.length} 个候选
              </span>
            </div>

            {/* List */}
            <div className="divide-y divide-line-faint border border-line rounded-card overflow-hidden">
              {items.map((it) => {
                const checked = selectedIds.has(it.id);
                return (
                  <div
                    key={it.id}
                    className={`px-3 py-2 flex items-center gap-2.5 text-label transition-colors ${
                      it.canClean ? "hover:bg-surface-hover cursor-pointer" : "opacity-50"
                    }`}
                    onClick={() => it.canClean && toggleSelect(it.id)}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!it.canClean}
                      onCheckedChange={() => toggleSelect(it.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择 ${it.name}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-ui text-ink truncate">{it.name}</span>
                        {it.branch && it.branch !== it.name && (
                          <span className="font-mono text-ink-faint truncate max-w-40">
                            {it.branch}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-nano text-ink-faint truncate mt-0.5">
                        {it.path}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      {!it.exists && <Badge>目录已删除</Badge>}
                      {it.sessionCount > 0 && (
                        <Badge variant="warn">{it.sessionCount} 个会话</Badge>
                      )}
                      {it.dirtyCount > 0 && (
                        <Badge variant="warn">{it.dirtyCount} 处未提交改动</Badge>
                      )}
                      {it.ignoredCount > 0 && (
                        <Badge variant="warn">{it.ignoredCount} 个被忽略的文件</Badge>
                      )}
                      {it.reason && <Badge variant="danger">{it.reason}</Badge>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!!cleanError && (
          <ErrorCallout compact className="mt-3" error={cleanError} title="清理失败" />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-2 shrink-0 bg-surface">
        <span className="text-label text-ink-faint">
          已选 {selectedIds.size} 个工作区
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={cleaning}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={handleClean}
            loading={cleaning}
            disabled={selectedIds.size === 0 || cleaning}
          >
            清理 {selectedIds.size} 个
          </Button>
        </div>
      </div>
    </Modal>
  );
}
