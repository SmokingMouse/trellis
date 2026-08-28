"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
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
  const [error, setError] = useState<string | null>(null);
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
      .catch(() => setError("网络请求失败"))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  if (!workspaceId) return null;

  const totalAdditions = data?.files.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  const openInVSCode = (path: string) => {
    window.location.href = `vscode://file/${encodeURI(path)}`;
  };

  const statusBadge = (status: ChangedFile["status"], staged: boolean) => {
    let color = "bg-surface-muted text-ink-faint";
    let text: string = status;
    if (status === "M") color = staged ? "bg-accent/20 text-accent-ink" : "bg-warn-muted text-warn-ink";
    else if (status === "A") color = "bg-positive-muted text-positive-ink";
    else if (status === "D") color = "bg-danger-muted text-danger-ink";
    else if (status === "??") {
      color = "bg-surface-muted text-ink-faint";
      text = "未跟踪";
    }

    return (
      <span className={`px-1 py-0.5 rounded text-nano font-mono font-semibold ${color}`}>
        {text}
      </span>
    );
  };

  return (
    <Modal onClose={onClose} size="lg" panelClassName="max-h-[85vh] flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-ui text-ink-strong truncate">
            {data?.name || workspaceName || "工作区变更"}
          </span>
          {data?.branch && (
            <span className="px-1.5 py-0.5 rounded bg-surface-muted border border-line text-nano font-mono text-ink-muted shrink-0">
              ⎇ {data.branch}
            </span>
          )}
          {data && (data.ahead > 0 || data.behind > 0) && (
            <span className="text-nano text-ink-faint shrink-0">
              {data.ahead > 0 && `↑${data.ahead} `}
              {data.behind > 0 && `↓${data.behind}`}
            </span>
          )}
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      {/* Path & Quick Actions Toolbar */}
      <div className="px-4 py-2 bg-surface-muted/50 border-b border-line-faint flex flex-wrap items-center justify-between gap-2 shrink-0 text-nano">
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
              💻 VS Code
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
              ＋ 开新会话
            </Button>
          )}
        </div>
      </div>

      {/* Body Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <div className="py-12 text-center text-ink-faint text-ui italic">
            正在读取工作区 Git 状态与变更…
          </div>
        ) : error ? (
          <div className="py-8 text-center text-danger text-ui">
            读取失败：{error}
          </div>
        ) : !data?.isGit ? (
          <div className="py-8 text-center text-ink-faint text-ui">
            当前目录不是 Git 工作区
          </div>
        ) : data.files.length === 0 ? (
          <div className="py-12 text-center text-ink-faint">
            <div className="text-2xl mb-2">✨</div>
            <div className="text-ui font-medium text-ink-strong">工作区非常干净</div>
            <div className="text-nano text-ink-faint mt-1">没有未提交或未跟踪的代码变更</div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Summary Stat */}
            <div className="flex items-center gap-3 text-nano">
              <span className="font-medium text-ink-strong">
                共 {data.files.length} 个变更文件
              </span>
              <div className="flex items-center gap-1.5 font-mono tabular-nums">
                <span className="text-positive-ink">+{totalAdditions}</span>
                <span className="text-danger-ink">−{totalDeletions}</span>
              </div>
            </div>

            {/* Files List */}
            <div className="border border-line rounded-md bg-surface-canvas overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-muted/60 border-b border-line text-nano font-medium text-ink-muted">
                变更文件清单
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-line-faint">
                {data.files.map((f) => (
                  <div
                    key={f.path}
                    onClick={() => setSelectedFile(f.path)}
                    className={`px-3 py-1.5 flex items-center justify-between text-nano hover:bg-surface-muted cursor-pointer transition-colors ${
                      selectedFile === f.path ? "bg-surface-muted/80 font-medium" : ""
                    }`}
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
              <div className="border border-line rounded-md bg-surface-canvas overflow-hidden flex flex-col">
                <div className="px-3 py-1.5 bg-surface-muted/60 border-b border-line flex items-center justify-between shrink-0">
                  <span className="text-nano font-medium text-ink-muted">Git Diff 预览</span>
                  <CopyButton text={data.diff} label="复制 Diff" />
                </div>
                <div className="p-3 max-h-72 overflow-y-auto font-mono text-nano text-ink whitespace-pre-wrap select-text leading-relaxed bg-[#18181b] text-[#f4f4f5] dark:bg-[#09090b]">
                  {data.diff.split("\n").map((line, idx) => {
                    let lineCls = "text-[#a1a1aa]";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                      lineCls = "text-[#4ade80] bg-[#14532d]/30 block px-1 -mx-1";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                      lineCls = "text-[#f87171] bg-[#7f1d1d]/30 block px-1 -mx-1";
                    } else if (line.startsWith("@@")) {
                      lineCls = "text-[#38bdf8] font-bold block mt-1";
                    } else if (line.startsWith("#")) {
                      lineCls = "text-[#fbbf24] font-semibold block mb-1";
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
        <Button variant="secondary" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>
    </Modal>
  );
}
