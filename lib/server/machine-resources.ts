import "server-only";

import { cpus, freemem, totalmem, type CpuInfo } from "node:os";
import { statfs } from "node:fs/promises";

export type MachineResources = {
  sampledAt: string;
  cpu: { usagePercent: number };
  memory: { usedBytes: number; totalBytes: number; usagePercent: number };
  disk: { usedBytes: number; totalBytes: number; usagePercent: number; path: string };
};

type CpuTotals = { idle: number; total: number };

function cpuTotals(rows: CpuInfo[]): CpuTotals {
  return rows.reduce(
    (sum, cpu) => {
      const total = Object.values(cpu.times).reduce((n, value) => n + value, 0);
      return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
    },
    { idle: 0, total: 0 },
  );
}

function percent(used: number, total: number): number {
  if (total <= 0) throw new Error("系统返回了无效的资源总量");
  return Math.round((used / total) * 1000) / 10;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 每次调用都现采样；调用方不得在失败时复用上一次结果。 */
export async function collectMachineResources(): Promise<MachineResources> {
  const before = cpuTotals(cpus());
  await wait(200);
  const after = cpuTotals(cpus());
  const elapsed = after.total - before.total;
  const idle = after.idle - before.idle;
  if (elapsed <= 0) throw new Error("无法取得 CPU 采样区间");

  const memoryTotal = totalmem();
  const memoryUsed = memoryTotal - freemem();

  // process.cwd() 就是 Trellis 服务的工作目录；statfs 返回它所在的文件系统。
  const diskPath = process.cwd();
  const fs = await statfs(diskPath);
  const diskTotal = fs.blocks * fs.bsize;
  const diskUsed = (fs.blocks - fs.bfree) * fs.bsize;

  return {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: percent(elapsed - idle, elapsed) },
    memory: {
      usedBytes: memoryUsed,
      totalBytes: memoryTotal,
      usagePercent: percent(memoryUsed, memoryTotal),
    },
    disk: {
      usedBytes: diskUsed,
      totalBytes: diskTotal,
      usagePercent: percent(diskUsed, diskTotal),
      path: diskPath,
    },
  };
}
