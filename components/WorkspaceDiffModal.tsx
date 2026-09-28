"use client";
import { useEffect, useState } from "react";
import { Code, GitBranch, GitCommitHorizontal, Plus, X } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Modal,
  Skeleton,
  SkeletonText,
  cn,
} from "@/components/ui";
import { CopyButton } from "@/components/CopyButton";
import type { ChangedFile } from "@/app/api/workspaces/git-diff/route";

export type WorkspaceDiffModalProps = {
  workspaceId: string | null;
  workspaceName?: string;
  workspacePath?: string;
  onClose: () => void;
  onStartSession?: (path: string) => void;
};

type DiffData = {
  workspaceId: string;
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  diff: string;
  dirtyCount: number;
};

export function WorkspaceDiffModal({
  workspaceId,
  workspaceName,
  workspacePath,
  onClose,
  onStartSession,
}: WorkspaceDiffModalProps) {
  const [data, setData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/workspaces/git-diff?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setError(res.error);
        } else {
          setData(res);
          if (res.files && res.files.length > 0) {
            setSelectedFile(res.files[0].path);
          }
        }
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [workspaceId, reloadKey]);

  if (!workspaceId) return null;

  const totalAdditions = data?.files.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  const openInVSCode = (path: string) => {
    window.location.href = `vscode://file/${encodeURI(path)}`;
  };

  const statusBadge = (status: ChangedFile["status"], staged: boolean) => {
    let color = "bg-surface-muted text-ink-faint";
    let text: string = status;
    if (status === "M") color = staged ? "bg-accent-muted text-accent-ink" : "bg-warn-muted text-warn-ink";
    else if (status === "A") color = "bg-positive-muted text-positive-ink";
    else if (status === "D") color = "bg-danger-muted text-danger-ink";
    else if (status === "??") {
      color = "bg-surface-muted text-ink-faint";
      text = "未跟踪";
    }

    return (
      <span className={`px-1 py-0.5 rounded-sm text-nano font-mono font-semibold ${color}`}>
        {text}
      </span>
    );
  };

  return (
    <Modal
      onClose={onClose}
      size="lg"
      title="工作区变更"
      panelClassName="max-h-[85vh] flex flex-col"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="font-semibold text-ui text-ink-strong truncate">
            {data?.name || workspaceName || "工作区变更"}
          </h2>
          {data?.branch && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-line text-label font-mono text-ink-muted shrink-0">
              <Icon icon={GitBranch} size="sm" />
              {data.branch}
            </span>
          )}
          {data && (data.ahead > 0 || data.behind > 0) && (
            <span
              className="text-label text-ink-faint shrink-0 tabular-nums"
              title={`领先上游 ${data.ahead} 个提交，落后 ${data.behind} 个`}
            >
              {data.ahead > 0 && `领先 ${data.ahead} `}
              {data.behind > 0 && `落后 ${data.behind}`}
            </span>
          )}
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          <Icon icon={X} />
        </IconButton>
      </div>

      {/* Path & Quick Actions Toolbar */}
      <div className="px-4 py-2 bg-surface-muted border-b border-line-faint flex flex-wrap items-center justify-between gap-2 shrink-0 text-label">
        <div className="flex items-center gap-1.5 font-mono text-ink-faint truncate max-w-md" title={data?.path || workspacePath}>
          <span className="truncate">{data?.path || workspacePath}</span>
          {(data?.path || workspacePath) && (
            <CopyButton text={data?.path || workspacePath || ""} label="复制路径" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {data?.path && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openInVSCode(data.path)}
              title="在本地 VS Code 中打开该工作区"
            >
              <Icon icon={Code} size="sm" />
              VS Code 打开
            </Button>
          )}
          {onStartSession && (data?.path || workspacePath) && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onStartSession(data?.path || workspacePath || "");
                onClose();
              }}
              title="在此工作区开启新会话"
            >
              <Icon icon={Plus} size="sm" />
              开新会话
            </Button>
          )}
        </div>
      </div>

      {/* Body Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-col gap-4" role="status" aria-label="正在读取工作区变更">
            <Skeleton className="h-4 w-40" />
            <SkeletonText lines={4} />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error ? (
          <ErrorCallout
            error={error}
            title="读取工作区变更失败"
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : !data?.isGit ? (
          <EmptyState
            compact
            icon={GitCommitHorizontal}
            title="这个目录不是 Git 仓库"
            description="只有 Git 工作区才能查看未提交的变更。"
          />
        ) : data.files.length === 0 ? (
          <EmptyState
            compact
            icon={GitCommitHorizontal}
            title="没有未提交的变更"
            description="工作区里没有修改过或未跟踪的文件。"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Summary Stat */}
            <div className="flex items-center gap-3 text-label">
              <span className="font-medium text-ink-strong">
                共 {data.files.length} 个变更文件
              </span>
              <div className="flex items-center gap-1.5 font-mono tabular-nums">
                <span className="text-positive-ink">+{totalAdditions}</span>
                <span className="text-danger-ink">−{totalDeletions}</span>
              </div>
            </div>

            {/* Files List */}
            <div className="border border-line rounded-card overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-muted border-b border-line text-label font-medium text-ink-muted">
                变更文件
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-line-faint">
                {data.files.map((f) => (
                  <div
                    key={f.path}
                    onClick={() => setSelectedFile(f.path)}
                    className={cn(
                      "px-3 py-1.5 flex items-center justify-between text-label hover:bg-surface-hover cursor-pointer transition-colors",
                      selectedFile === f.path && "bg-surface-hover font-medium",
                    )}
                  >
                    <div className="flex items-center gap-2 truncate pr-2">
                      {statusBadge(f.status, f.staged)}
                      <span className="font-mono text-ink truncate" title={f.path}>
                        {f.path}
                      </span>
                    </div>
                    {(f.additions > 0 || f.deletions > 0) && (
                      <span className="font-mono text-nano shrink-0 tabular-nums">
                        {f.additions > 0 && <span className="text-positive-ink">+{f.additions} </span>}
                        {f.deletions > 0 && <span className="text-danger-ink">−{f.deletions}</span>}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Unified Diff Box */}
            {data.diff && (
              <div className="border border-line rounded-card overflow-hidden flex flex-col">
                <div className="px-3 py-1.5 bg-surface-muted border-b border-line flex items-center justify-between shrink-0">
                  <span className="text-label font-medium text-ink-muted">差异预览</span>
                  <CopyButton text={data.diff} label="复制差异" title="复制完整 diff 文本" />
                </div>
                <div className="p-3 max-h-72 overflow-y-auto font-mono text-nano text-ink-muted whitespace-pre-wrap select-text leading-relaxed bg-surface-muted">
                  {data.diff.split("\n").map((line, idx) => {
                    let lineCls = "";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                      lineCls = "text-positive-ink bg-positive-muted block px-1 -mx-1";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                      lineCls = "text-danger-ink bg-danger-muted block px-1 -mx-1";
                    } else if (line.startsWith("@@")) {
                      lineCls = "text-accent-ink font-semibold block mt-1";
                    } else if (line.startsWith("#")) {
                      lineCls = "text-ink-strong font-semibold block mb-1";
                    }
                    return (
                      <div key={idx} className={lineCls}>
                        {line || " "}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-line flex items-center justify-end gap-2 shrink-0 bg-surface">
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
    </Modal>
  );
}
