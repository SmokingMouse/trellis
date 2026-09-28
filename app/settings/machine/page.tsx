"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatBytes } from "@/lib/format-bytes";
import { ErrorCallout, Icon, IconButton, PageHeader, Skeleton } from "@/components/ui";

type Snapshot = {
  sampledAt: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number; usagePercent: number };
  disk: { usedBytes: number; totalBytes: number; usagePercent: number; path: string };
};

export default function MachineResourcesPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback((): Promise<void> => {
    // 请求一开始就撤下旧快照：慢请求或失败期间都不能把旧数据展示成当前状态。
    setSnapshot(null);
    setLoading(true);
    setError(null);
    return fetch("/api/machine-resources", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setSnapshot(body as Snapshot);
      })
      .catch((cause: unknown) => {
        setError(cause ?? new Error("机器资源采集失败"));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // 延后一拍，让 load 内的状态更新发生在 effect 之外（项目既有 lint 约束）。
    void Promise.resolve().then(load);
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="机器资源"
        subtitle="当前 Trellis 服务进程所在机器；每 5 秒自动重新采集"
        actions={
          <IconButton label="刷新" onClick={() => void load()} disabled={loading}>
            <Icon icon={RefreshCw} />
          </IconButton>
        }
      />

      {error !== null && (
        <ErrorCallout
          error={error}
          title="资源状态暂不可用"
          hint="每 5 秒会自动重试一次；一直失败就看服务端日志。"
          onRetry={() => void load()}
        />
      )}

      {loading && error === null && !snapshot && (
        <div role="status" aria-label="正在采集资源状态" className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card border border-line bg-surface p-4 flex flex-col gap-2.5">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="mt-1 h-2 w-full" />
            </div>
          ))}
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <ResourceCard label="CPU" percent={snapshot.cpu.usagePercent} detail="当前使用率" />
            <ResourceCard
              label="内存"
              percent={snapshot.memory.usagePercent}
              detail={`${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`}
            />
            <ResourceCard
              label="磁盘"
              percent={snapshot.disk.usagePercent}
              detail={`${formatBytes(snapshot.disk.usedBytes)} / ${formatBytes(snapshot.disk.totalBytes)}`}
            />
          </div>
          <div className="rounded-card border border-line px-3 py-2 text-label text-ink-muted">
            <div>更新时间：{new Date(snapshot.sampledAt).toLocaleString("zh-CN")}</div>
            <div className="mt-1 truncate font-mono text-nano" title={snapshot.disk.path}>
              磁盘文件系统取自工作目录：{snapshot.disk.path}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ResourceCard({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="text-ui text-ink-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-ink-strong">{percent.toFixed(1)}%</div>
      <div className="mt-1 text-label text-ink-muted">{detail}</div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${safe}%` }} />
      </div>
    </section>
  );
}
