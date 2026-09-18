// CLI transcript 解析基准：改前（全量同步）vs 改后（stat 短路 + 尾部增量 + 分片让出）。
//
// 跑法（务必带 --conditions react-server，否则 server-only 会拦）：
//   bun --conditions react-server scripts/bench-cli-parse.ts [文件MB数]
//
// 量四件事：
//   1. 冷启动全量解析耗时
//   2. 解析期间的**事件循环最大单次阻塞**与本地 HTTP 健康检查 p95 / max
//   3. 稳态：追加 60KB 后再解析一次的耗时与实际读盘字节
//   4. 无变化再解析一次的耗时与实际读盘字节（短路应为 0 字节）
//
// 合成文件落在 os.tmpdir()，跑完删掉。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 本机 clash 会把 127.0.0.1 也劫走 —— 基准里的健康检查必须直连。
// 放在 main() 里而不是模块顶层：本文件的合成器被测试 import，不该顺手改测试
// 进程的代理环境。
function disableProxyForLocalProbe(): void {
  for (const key of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete process.env[key];
  }
  process.env.no_proxy = "*";
  process.env.NO_PROXY = "*";
}

const FILLER = "x".repeat(400);

/**
 * 合成一个形状贴近真实 claude transcript 的 jsonl：
 * 每个 turn = 1 条 user + 6 组（assistant 文本+tool_use / user tool_result）。
 * 返回实际字节数。
 */
export function writeSyntheticClaudeJsonl(
  target: string,
  turns: number,
  startTurn = 0,
  startUuid = 0,
  parentUuid: string | null = null,
): { bytes: number; lastUuid: string | null; nextUuid: number } {
  let n = startUuid;
  const uuid = () =>
    `${(n++).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
  const chunks: string[] = [];
  let prev = parentUuid;
  for (let t = startTurn; t < startTurn + turns; t++) {
    const uid = uuid();
    chunks.push(
      JSON.stringify({
        type: "user",
        uuid: uid,
        parentUuid: prev,
        sessionId: "bench-session",
        cwd: "/tmp/bench",
        gitBranch: "main",
        timestamp: ts(t * 10),
        promptSource: "typed",
        message: { role: "user", content: `question ${t} ${FILLER}` },
      }),
    );
    prev = uid;
    for (let k = 0; k < 6; k++) {
      const aid = uuid();
      chunks.push(
        JSON.stringify({
          type: "assistant",
          uuid: aid,
          parentUuid: prev,
          sessionId: "bench-session",
          timestamp: ts(t * 10 + k + 1),
          message: {
            role: "assistant",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 1,
            },
            content: [
              { type: "text", text: `answer ${t}.${k} ${FILLER}${FILLER}` },
              {
                type: "tool_use",
                id: `tu-${t}-${k}`,
                name: "Bash",
                input: { command: `ls ${FILLER}` },
              },
            ],
          },
        }),
      );
      prev = aid;
      const rid = uuid();
      chunks.push(
        JSON.stringify({
          type: "user",
          uuid: rid,
          parentUuid: prev,
          timestamp: ts(t * 10 + k + 1),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `tu-${t}-${k}`,
                content: FILLER + FILLER,
              },
            ],
          },
        }),
      );
      prev = rid;
    }
  }
  const text = `${chunks.join("\n")}\n`;
  if (startTurn === 0) fs.writeFileSync(target, text);
  else fs.appendFileSync(target, text);
  return {
    bytes: Buffer.byteLength(text),
    lastUuid: prev,
    nextUuid: n,
  };
}

/** 事件循环阻塞探针：记录相邻两次 1ms 定时器之间的实际间隔。 */
function startLagProbe() {
  let max = 0;
  const samples: number[] = [];
  let last = performance.now();
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    const lag = now - last - 1;
    if (lag > 0) samples.push(lag);
    if (lag > max) max = lag;
    last = now;
    if (!stopped) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  return {
    stop() {
      stopped = true;
      return { max, samples };
    },
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

type HealthProbe = {
  stop(): Promise<{ count: number; p95: number; max: number }>;
};

/** 本地 HTTP 健康检查探针：解析期间持续打点，量的是用户真实能感到的那条线。 */
function startHealthProbe(url: string): HealthProbe {
  const latencies: number[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const t0 = performance.now();
      try {
        await fetch(url);
        latencies.push(performance.now() - t0);
      } catch {
        /* 服务已关 */
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return {
        count: latencies.length,
        p95: percentile(latencies, 0.95),
        max: latencies.length ? Math.max(...latencies) : 0,
      };
    },
  };
}

async function main() {
  disableProxyForLocalProbe();
  const targetMb = Number(process.argv[2] ?? 60);
  const { parseCliSessionJsonl } = await import("../lib/server/cli-import");
  const {
    parseCliTranscript,
    parseCliTranscriptAsync,
    cliTranscriptCacheStats,
    resetCliTranscriptCache,
  } = await import("../lib/server/cli-transcript");

  const file = path.join(
    os.tmpdir(),
    `trellis-bench-cli-parse-${process.pid}.jsonl`,
  );
  // 每 turn ≈ 17KB。
  const turnsNeeded = Math.max(1, Math.round((targetMb * 1024 * 1024) / 17000));
  const cursor = writeSyntheticClaudeJsonl(file, turnsNeeded);
  const sizeMb = fs.statSync(file).size / 1024 / 1024;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const healthUrl = server.url.toString();

  const rows: string[][] = [];
  const fmt = (n: number) => n.toFixed(1);

  try {
    // ── 1. 改前：全量同步解析（老 parseCliSessionJsonl，无缓存无让出）────────
    {
      // 预热一次，排除首次 page cache / JIT 噪声。
      parseCliSessionJsonl(file);
      const lag = startLagProbe();
      const health = startHealthProbe(healthUrl);
      await Bun.sleep(30);
      const t0 = performance.now();
      const parsed = parseCliSessionJsonl(file);
      const elapsed = performance.now() - t0;
      await Bun.sleep(30);
      const { max } = lag.stop();
      const h = await health.stop();
      rows.push([
        "改前 全量同步解析",
        fmt(elapsed),
        fmt(max),
        fmt(h.p95),
        fmt(h.max),
        "整文件",
        String(parsed?.turns.length ?? 0),
      ]);
    }

    // ── 2. 改后：冷缓存首次（异步分片）────────────────────────────────────
    resetCliTranscriptCache();
    let coldTurns = 0;
    {
      const before = cliTranscriptCacheStats();
      const lag = startLagProbe();
      const health = startHealthProbe(healthUrl);
      await Bun.sleep(30);
      const t0 = performance.now();
      const parsed = await parseCliTranscriptAsync("claude", file);
      const elapsed = performance.now() - t0;
      await Bun.sleep(30);
      const { max } = lag.stop();
      const h = await health.stop();
      const after = cliTranscriptCacheStats();
      coldTurns = parsed?.turns.length ?? 0;
      rows.push([
        "改后 冷缓存首次（分片）",
        fmt(elapsed),
        fmt(max),
        fmt(h.p95),
        fmt(h.max),
        `${fmt((after.bytesRead - before.bytesRead) / 1024 / 1024)}MB`,
        String(coldTurns),
      ]);
    }

    // ── 3. 稳态：追加 60KB 后再解析（改前全量 vs 改后增量）──────────────────
    writeSyntheticClaudeJsonl(
      file,
      4, // ≈ 68KB
      turnsNeeded,
      cursor.nextUuid,
      cursor.lastUuid,
    );
    {
      const t0 = performance.now();
      const parsed = parseCliSessionJsonl(file);
      const elapsed = performance.now() - t0;
      rows.push([
        "改前 追加 60KB 后重解析",
        fmt(elapsed),
        "—",
        "—",
        "—",
        "整文件",
        String(parsed?.turns.length ?? 0),
      ]);
    }
    {
      const before = cliTranscriptCacheStats();
      const lag = startLagProbe();
      const health = startHealthProbe(healthUrl);
      await Bun.sleep(30);
      const t0 = performance.now();
      const parsed = await parseCliTranscriptAsync("claude", file);
      const elapsed = performance.now() - t0;
      await Bun.sleep(30);
      const { max } = lag.stop();
      const h = await health.stop();
      const after = cliTranscriptCacheStats();
      rows.push([
        "改后 追加 60KB 后增量解析",
        fmt(elapsed),
        fmt(max),
        fmt(h.p95),
        fmt(h.max),
        `${fmt((after.bytesRead - before.bytesRead) / 1024)}KB`,
        String(parsed?.turns.length ?? 0),
      ]);
    }

    // ── 4. 无变化再解析（stat 短路）─────────────────────────────────────────
    {
      const before = cliTranscriptCacheStats();
      const t0 = performance.now();
      const parsed = parseCliTranscript("claude", file);
      const elapsed = performance.now() - t0;
      const after = cliTranscriptCacheStats();
      rows.push([
        "改后 无变化再解析（短路）",
        elapsed.toFixed(3),
        "—",
        "—",
        "—",
        `${after.bytesRead - before.bytesRead}B`,
        String(parsed?.turns.length ?? 0),
      ]);
    }

    const header = [
      "场景",
      "解析耗时ms",
      "事件循环最大阻塞ms",
      "健康检查p95ms",
      "健康检查maxms",
      "读盘量",
      "turns",
    ];
    const widths = header.map((h, i) =>
      Math.max(
        [...h].length,
        ...rows.map((r) => [...r[i]].length),
      ),
    );
    const line = (cells: string[]) =>
      cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log(`\n合成文件 ${sizeMb.toFixed(1)}MB / ${turnsNeeded} turns  (${file})\n`);
    console.log(line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of rows) console.log(line(r));
    console.log("");
  } finally {
    server.stop(true);
    fs.rmSync(file, { force: true });
  }
}

if (import.meta.main) {
  await main();
}
