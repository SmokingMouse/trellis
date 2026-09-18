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

/**
 * 合成一个形状贴近真实 codex rollout 的 jsonl：首行 session_meta（cwd / id 都在
 * 这里，cli-discover 的 meta 采样只读这一行），之后每个 turn = turn_context +
 * user message + function_call + function_call_output + final_answer。
 *
 * 用于根因 D 的回归：首次 attach 一个大 rollout 时事件循环不许被占住，以及
 * 几百个 rollout 的兄弟枚举不许每轮重扫 meta。
 */
export function writeSyntheticCodexRollout(
  target: string,
  turns: number,
  options: {
    sessionId: string;
    cwd: string;
    /** 兄弟 fork 用：让两个文件共享同一套 turn_id。默认用自己的 sessionId。 */
    turnPrefix?: string;
    /**
     * 每个 turn 的填充字节数（默认 400B×4 ≈ 一个小 turn）。调大它可以做出
     * 「turn 不多但每个都很肥」的文件 —— devbox 上那个 1.28GB 的 rollout 就是
     * 这个形状（一个长跑会话、工具输出巨大），而不是几百万个小 turn。
     */
    fillerBytes?: number;
    /**
     * 提问 / 最终答复的填充字节数（默认跟随 fillerBytes）。单独拎出来是因为这两
     * 段会进 search_index 做全文索引，而工具调用与其输出不会 —— 想把「解析成本」
     * 和「DB 落地成本」分开量的时候，把这个压小、fillerBytes 放大即可。
     */
    textFillerBytes?: number;
    /**
     * 每个 turn 额外附带的「噪声」字节：解析器**认得但会丢弃**的 event_msg
     * （真实 rollout 里 agent_reasoning_delta 这类占了绝大多数体积）。它照样要被
     * 按行切开、JSON.parse、走一遍 reduce，但一个字节都不会进 node —— 用来做出
     * 「解析成本很大、DB 落地成本很小」的文件，把事件循环阻塞的来源钉死在解析上。
     */
    noiseBytes?: number;
  },
): { bytes: number } {
  const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
  const prefix = options.turnPrefix ?? options.sessionId;
  const repeats = (bytes: number) =>
    FILLER.repeat(Math.max(1, Math.round(bytes / FILLER.length)));
  const pad = repeats(options.fillerBytes ?? 400);
  const textPad = repeats(options.textFillerBytes ?? options.fillerBytes ?? 400);
  const noisePad = options.noiseBytes ? repeats(options.noiseBytes) : null;
  const chunks: string[] = [
    JSON.stringify({
      timestamp: ts(0),
      type: "session_meta",
      payload: {
        id: options.sessionId,
        cwd: options.cwd,
        git: { branch: "main" },
        // 真实 rollout 的首行带 base_instructions，能有几百 KB —— meta 采样的
        // 代价（以及缓存的收益）都在这一行上。
        base_instructions: FILLER.repeat(8),
      },
    }),
  ];
  for (let t = 0; t < turns; t++) {
    const tid = `${prefix}-turn-${t}`;
    const meta = { internal_chat_message_metadata_passthrough: { turn_id: tid } };
    chunks.push(
      JSON.stringify({
        timestamp: ts(t * 10 + 1),
        type: "turn_context",
        payload: { turn_id: tid },
      }),
      JSON.stringify({
        timestamp: ts(t * 10 + 2),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `question ${t} ${textPad}` }],
          ...meta,
        },
      }),
      JSON.stringify({
        timestamp: ts(t * 10 + 3),
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: `call-${tid}`,
          name: "shell",
          arguments: JSON.stringify({ cmd: `ls ${pad}` }),
          ...meta,
        },
      }),
      JSON.stringify({
        timestamp: ts(t * 10 + 4),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call-${tid}`,
          output: pad + pad,
          ...meta,
        },
      }),
      JSON.stringify({
        timestamp: ts(t * 10 + 5),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: `answer ${t} ${textPad}` }],
          ...meta,
        },
      }),
    );
    if (noisePad) {
      chunks.push(
        JSON.stringify({
          timestamp: ts(t * 10 + 6),
          type: "event_msg",
          payload: { type: "agent_reasoning_delta", delta: noisePad, ...meta },
        }),
      );
    }
  }
  const text = `${chunks.join("\n")}\n`;
  fs.writeFileSync(target, text);
  return { bytes: Buffer.byteLength(text) };
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
