"use client";

import { useCallback, useEffect, useState } from "react";

type Snapshot = {
  sampledAt: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number; usagePercent: number };
  disk: { usedBytes: number; totalBytes: number; usagePercent: number; path: string };
};

export default function MachineResourcesPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        setError(cause instanceof Error ? cause.message : "机器资源采集失败");
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
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold">Trellis 服务机器</h2>
        <p className="mt-1 text-label text-ink-faint">
          仅展示当前 Trellis 服务进程所在机器；数据每 5 秒重新采集。
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-surface px-3 py-2 text-ui">
          <div className="font-medium">资源状态不可用</div>
          <div className="mt-1 text-label">{error}，正在自动重试。</div>
        </div>
      )}

      {loading && !error && (
        <div role="status" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-ui text-ink-muted">
          正在采集当前资源状态…
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
          <div className="rounded-md border border-line-faint bg-surface-muted px-3 py-2 text-label text-ink-muted">
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
    <section className="rounded-card border border-line bg-surface shadow-raise p-4">
      <div className="text-ui font-medium">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{percent.toFixed(1)}%</div>
      <div className="mt-1 text-label text-ink-muted">{detail}</div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${safe}%` }} />
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
