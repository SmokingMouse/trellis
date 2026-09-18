// 根因 D 的常驻回归：**herdr 首次 attach** 这条路径不许占住事件循环，也不许每轮
// 重扫上千个兄弟文件的 meta。
//
// 现场（BOE devbox n37-109-213）：codex 目录 1406 个 jsonl / 3.4GB，单个最大
// rollout 1.28GB。fix-b 的异步化只覆盖了启动补齐与 watcher 的 reimport，
// herdr-fleet 的自动 attach 仍是同步全量 parse —— 首次 attach 一个大 rollout
// 就是一次数十秒的主线程阻塞；而 fleet 每 60s snapshot 会把同一批 transcript
// 重放一遍，兄弟枚举又把上千个文件的首行重读一遍。
//
// 这里的量法与 cli-transcript-eventloop.test.ts 一致（1ms 定时器打点）。
// 必须走子进程：CODEX_HOME_DIR / PROJECTS_DIR 是模块级常量，本进程里 cli-discover
// 早被别的用例按真实 $HOME 加载过了，改 env 不会重算。
import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const tempRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "trellis-attach-async-")),
);

// 第 4 组用例在本进程里跑（claude 侧的 discoverLineage 只看文件自己所在的目录，
// 不碰模块级的 PROJECTS_DIR / CODEX_SESSIONS_DIR），所以给它一套自己的库。
const previousDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(tempRoot, "test.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { attachSessionAsync } = await import("./cli-sync-watcher");
const { attachHerdrTranscript } = await import("./herdr-bindings");
const { discoverLineageAsync } = await import("./cli-discover");
const {
  CliTranscriptNoTurnsError,
  CliTranscriptUnreadableError,
  NativeSessionConflictError,
  isDeterministicAttachFailure,
} = await import("./cli-attach");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previousDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousDbPath;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** 一个独立的假 HOME：codex sessions 树 + 自己的 sqlite。 */
function fakeHome(name: string): { home: string; sessionsDir: string } {
  const home = path.join(tempRoot, name);
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "09", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { home, sessionsDir };
}

function runInFakeHome(
  home: string,
  script: string,
): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(["bun", "--conditions", "react-server", "-"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      TRELLIS_REPO: repoRoot,
      TRELLIS_DB_PATH: path.join(home, "trellis.db"),
      TRELLIS_LARK: "off",
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      no_proxy: "*",
    },
    stdin: new TextEncoder().encode(script),
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

const PRELUDE = `
  import { mock } from "bun:test";
  mock.module("server-only", () => ({}));
  const { writeSyntheticCodexRollout } = await import(${JSON.stringify(path.join(repoRoot, "scripts/bench-cli-parse.ts"))});
  const { attachHerdrTranscript } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/herdr-bindings.ts"))});
  const { attachSession } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/cli-sync-watcher.ts"))});
  const { cliDiscoverCacheStats, resetCliDiscoverCache } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/cli-discover.ts"))});
  const { resetCliTranscriptCache } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/cli-transcript.ts"))});
  /**
   * 1ms 定时器打点。两个读数：
   *   maxLag  相邻两次回调的最大间隔 = 那一刻事件循环被占用的最长时长
   *   ticks   期间总共跑成了几次回调 —— **同步实现下这个数恒为 1**（整段被一个
   *           调用栈占死，定时器只能在它结束后补跑一次）。判「真的让出了」比判
   *           「阻塞多少毫秒」稳得多：后者随机器速度和文件大小浮动。
   */
  function startLagProbe() {
    let max = 0;
    let ticks = 0;
    let last = performance.now();
    let stopped = false;
    const tick = () => {
      const now = performance.now();
      const lag = now - last - 1;
      if (lag > max) max = lag;
      last = now;
      ticks++;
      if (!stopped) setTimeout(tick, 1);
    };
    setTimeout(tick, 1);
    return {
      // 定时器链热起来之后清零，读数只覆盖被测的那一段。
      reset() { max = 0; ticks = 0; last = performance.now(); },
      // ticks 必须在被测调用**刚返回**时读：之后为了等最后一段阻塞的补跑回调还要
      // 睡一会儿，那期间的 tick 与被测对象无关。
      ticks() { return ticks; },
      stop() { stopped = true; return { max, ticks }; },
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const emit = (label, payload) =>
    process.stdout.write("::" + label + "::" + JSON.stringify(payload) + "\\n");
`;

function readEmitted<T>(stdout: string, label: string): T {
  const line = stdout
    .split("\n")
    .find((l) => l.startsWith(`::${label}::`));
  if (!line) throw new Error(`子进程没有输出 ${label}：\n${stdout}`);
  return JSON.parse(line.slice(`::${label}::`.length)) as T;
}

// ── 1. 事件循环不被占住 ──────────────────────────────────────────────────────

test(
  "herdr 首次 attach 一个 ~35MB codex rollout：解析期间事件循环不被占住",
  () => {
    const { home, sessionsDir } = fakeHome("eventloop");
    // 夹具形状：400 个 turn，每个 turn 的正文很小，但挂 ~90KB 会被解析器丢弃的
    // event_msg 噪声（真实 rollout 里 agent_reasoning_delta 这类就是绝大多数
    // 体积）。这样 35MB 全都要被切行 + JSON.parse + reduce，而落进 DB 的 node
    // 负载很小 —— **量的就是解析这一段**，不会被 SQLite 事务的固有同步开销糊住
    // （那一段本改动没动，也不该动：拆事务就等于放弃原子性，见 out/README.md）。
    const turns = 400;
    const noiseBytes = Math.round((35 * 1024 * 1024) / turns);
    const asyncSid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const syncSid = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const asyncFile = path.join(
      sessionsDir,
      `rollout-2026-09-18T10-00-00-${asyncSid}.jsonl`,
    );
    const syncFile = path.join(
      sessionsDir,
      `rollout-2026-09-18T11-00-00-${syncSid}.jsonl`,
    );

    const script = `
      ${PRELUDE}
      const shape = { fillerBytes: 400, textFillerBytes: 400, noiseBytes: ${noiseBytes} };
      // cwd 故意不同：两个 rollout 不该被当成同一条 lineage 的兄弟。
      const asyncBytes = writeSyntheticCodexRollout(${JSON.stringify(asyncFile)}, ${turns}, {
        sessionId: ${JSON.stringify(asyncSid)},
        cwd: ${JSON.stringify(path.join(home, "project-async"))},
        ...shape,
      }).bytes;
      const syncBytes = writeSyntheticCodexRollout(${JSON.stringify(syncFile)}, ${turns}, {
        sessionId: ${JSON.stringify(syncSid)},
        cwd: ${JSON.stringify(path.join(home, "project-sync"))},
        ...shape,
      }).bytes;

      // 改后：herdr 的自动 attach 入口（attachHerdrTranscript → attachSessionAsync）。
      resetCliTranscriptCache();
      resetCliDiscoverCache();
      let probe = startLagProbe();
      await sleep(20);
      probe.reset();
      const t0 = performance.now();
      const outcome = await attachHerdrTranscript(${JSON.stringify(asyncFile)}, "codex");
      const asyncElapsed = performance.now() - t0;
      const asyncTicks = probe.ticks();
      // 先睡一下再读 maxLag：最后一段阻塞要等它结束后那次「补跑」的回调才被记
      // 进去，读早了等于把尾巴上的阻塞全漏掉。
      await sleep(20);
      const asyncProbe = probe.stop();

      // 改前基线：同一形状的文件走同步 attachSession（老 herdr 路径的行为）。
      resetCliTranscriptCache();
      resetCliDiscoverCache();
      probe = startLagProbe();
      await sleep(20);
      probe.reset();
      const t1 = performance.now();
      const syncStatus = attachSession(${JSON.stringify(syncFile)}, "codex", { origin: "herdr" }).status;
      const syncElapsed = performance.now() - t1;
      const syncTicks = probe.ticks();
      await sleep(20);
      const syncProbe = probe.stop();

      emit("eventloop", {
        mb: asyncBytes / 1024 / 1024,
        syncMb: syncBytes / 1024 / 1024,
        outcome, syncStatus,
        asyncMaxLag: asyncProbe.max, asyncTicks, asyncElapsed,
        syncMaxLag: syncProbe.max, syncTicks, syncElapsed,
      });
      process.exit(0);
    `;
    const run = runInFakeHome(home, script);
    expect(run.exitCode, run.stderr + run.stdout).toBe(0);
    const m = readEmitted<{
      mb: number;
      syncMb: number;
      outcome: string;
      syncStatus: string;
      asyncMaxLag: number;
      asyncTicks: number;
      asyncElapsed: number;
      syncMaxLag: number;
      syncTicks: number;
      syncElapsed: number;
    }>(run.stdout, "eventloop");

    console.log(
      `[attach-async] ${m.mb.toFixed(1)}MB rollout  async: ${m.asyncElapsed.toFixed(0)}ms / maxLag ${m.asyncMaxLag.toFixed(1)}ms / 期间事件循环跑了 ${m.asyncTicks} 次` +
        `   sync 基线: ${m.syncElapsed.toFixed(0)}ms / maxLag ${m.syncMaxLag.toFixed(1)}ms / ${m.syncTicks} 次`,
    );

    // 夹具真的够大，否则用例没有区分力。
    expect(m.mb).toBeGreaterThan(30);
    // attach 真的成功了（不是靠失败短路跑得快）。
    expect(m.outcome).toBe("attached");
    expect(m.syncStatus).toBe("imported");
    // 判据一：单次阻塞上限。
    expect(m.asyncMaxLag).toBeLessThan(100);
    // 判据二（真正的区分力所在）：整个 attach 期间事件循环**反复拿回过控制权**。
    // 同步实现下这个数恒为 1 —— 整段被一个调用栈占死，定时器只能在它跑完后补跑
    // 一次。它不随机器速度浮动，所以比毫秒阈值靠得住：合成文件在快机器上可能
    // 连同步路径都跑不满 100ms，但「让没让出」是二值的。
    expect(m.syncTicks).toBeLessThanOrEqual(1);
    expect(m.asyncTicks).toBeGreaterThan(5);
  },
  300_000,
);

// ── 2. 扫描有上界 ───────────────────────────────────────────────────────────

test(
  "连续 attach 三次：兄弟枚举的 meta 采样与前缀扫描第二次起归零",
  () => {
    const { home, sessionsDir } = fakeHome("scan-bound");
    const siblings = 400;
    const targetSid = "cccccccc-3333-4333-8333-cccccccccccc";
    const targetFile = path.join(
      sessionsDir,
      `rollout-2026-09-18T12-00-00-${targetSid}.jsonl`,
    );

    const script = `
      ${PRELUDE}
      const cwd = ${JSON.stringify(path.join(home, "shared-project"))};
      // 全部同一个 cwd：最坏情况 —— 每个兄弟都过得了 cwd 闸，于是都要再被前缀
      // 扫描一遍找 rootTurnId。devbox 上 1406 个文件同属几个 repo，就是这个形状。
      for (let i = 0; i < ${siblings}; i++) {
        const sid = "dddddddd-4444-4444-8444-" + String(i).padStart(12, "0");
        writeSyntheticCodexRollout(
          ${JSON.stringify(sessionsDir)} + "/rollout-2026-09-18T09-00-00-" + sid + ".jsonl",
          4,
          { sessionId: sid, cwd },
        );
      }
      writeSyntheticCodexRollout(${JSON.stringify(targetFile)}, 4, {
        sessionId: ${JSON.stringify(targetSid)},
        cwd,
      });

      resetCliTranscriptCache();
      resetCliDiscoverCache();
      const rounds = [];
      let before = cliDiscoverCacheStats();
      for (let round = 0; round < 3; round++) {
        const t0 = performance.now();
        const outcome = await attachHerdrTranscript(${JSON.stringify(targetFile)}, "codex");
        const elapsed = performance.now() - t0;
        const after = cliDiscoverCacheStats();
        rounds.push({
          outcome,
          elapsed,
          metaSamples: after.metaSamples - before.metaSamples,
          metaHits: after.metaHits - before.metaHits,
          fingerprintStats: after.fingerprintStats - before.fingerprintStats,
          prefixScans: after.prefixScans - before.prefixScans,
          prefixHits: after.prefixHits - before.prefixHits,
          treeWalks: after.treeWalks - before.treeWalks,
          treeReuses: after.treeReuses - before.treeReuses,
        });
        before = after;
      }
      emit("scan", { rounds });
      process.exit(0);
    `;
    const run = runInFakeHome(home, script);
    expect(run.exitCode, run.stderr + run.stdout).toBe(0);
    const { rounds } = readEmitted<{
      rounds: {
        outcome: string;
        elapsed: number;
        metaSamples: number;
        metaHits: number;
        fingerprintStats: number;
        prefixScans: number;
        prefixHits: number;
        treeWalks: number;
        treeReuses: number;
      }[];
    }>(run.stdout, "scan");

    for (const [i, r] of rounds.entries()) {
      console.log(
        `[attach-async] ${siblings + 1} 个 rollout，第 ${i + 1} 次 attach ${r.elapsed.toFixed(0)}ms：` +
          ` meta 采样 ${r.metaSamples} / 命中 ${r.metaHits}，前缀扫描 ${r.prefixScans} / 命中 ${r.prefixHits}，` +
          ` 走树 ${r.treeWalks} / 复用 ${r.treeReuses}，指纹 stat ${r.fingerprintStats}`,
      );
    }

    // 第一次是冷的：每个文件都要读首行 + 读前缀，整棵树走一遍。
    expect(rounds[0].outcome).toBe("attached");
    expect(rounds[0].metaSamples).toBeGreaterThanOrEqual(siblings);
    expect(rounds[0].prefixScans).toBeGreaterThanOrEqual(siblings);
    expect(rounds[0].treeWalks).toBe(1);
    // 第二次及以后：一个字节都不再读，只剩 stat。
    for (const r of rounds.slice(1)) {
      expect(r.outcome).toBe("attached");
      expect(r.metaSamples).toBe(0);
      expect(r.prefixScans).toBe(0);
      expect(r.treeWalks).toBe(0);
      expect(r.treeReuses).toBeGreaterThanOrEqual(1);
      expect(r.metaHits).toBeGreaterThanOrEqual(siblings);
    }
  },
  300_000,
);

// ── 3. 新落的兄弟文件仍然能被发现（缓存的失效边界）─────────────────────────

test("新增一个兄弟 rollout 后，目录 mtime 变化让枚举重走", () => {
  const { home, sessionsDir } = fakeHome("invalidate");
  const rootSid = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
  const rootFile = path.join(
    sessionsDir,
    `rollout-2026-09-18T13-00-00-${rootSid}.jsonl`,
  );

  const script = `
    ${PRELUDE}
    const cwd = ${JSON.stringify(path.join(home, "fork-project"))};
    writeSyntheticCodexRollout(${JSON.stringify(rootFile)}, 3, {
      sessionId: ${JSON.stringify(rootSid)},
      cwd,
    });
    resetCliTranscriptCache();
    resetCliDiscoverCache();
    const first = await attachHerdrTranscript(${JSON.stringify(rootFile)}, "codex");
    const firstStats = cliDiscoverCacheStats();

    // fork：同 cwd、共享同一套 turn_id（前缀里含 root turn id），所以应当被认成
    // 同一条 lineage 的兄弟。
    const forkSid = "ffffffff-6666-4666-8666-ffffffffffff";
    writeSyntheticCodexRollout(
      ${JSON.stringify(sessionsDir)} + "/rollout-2026-09-18T14-00-00-" + forkSid + ".jsonl",
      5,
      { sessionId: forkSid, cwd, turnPrefix: ${JSON.stringify(rootSid)} },
    );
    const second = await attachHerdrTranscript(${JSON.stringify(rootFile)}, "codex");
    const secondStats = cliDiscoverCacheStats();
    const { getDB } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/sqlite.ts"))});
    const members = getDB()
      .prepare("SELECT cli_session_id AS sid, is_root AS isRoot FROM cli_lineages ORDER BY sid")
      .all();
    emit("invalidate", {
      first, second, members,
      walksAfterFirst: firstStats.treeWalks,
      walksAfterSecond: secondStats.treeWalks,
    });
    process.exit(0);
  `;
  const run = runInFakeHome(home, script);
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  const m = readEmitted<{
    first: string;
    second: string;
    members: { sid: string; isRoot: number }[];
    walksAfterFirst: number;
    walksAfterSecond: number;
  }>(run.stdout, "invalidate");

  expect(m.first).toBe("attached");
  expect(m.second).toBe("attached");
  // 目录里多了一个文件 → 目录 mtime 变 → 必须重走，不能拿旧列表糊过去。
  expect(m.walksAfterFirst).toBe(1);
  expect(m.walksAfterSecond).toBe(2);
  // 新 fork 真的进了同一条 lineage。
  expect(m.members.map((row) => row.sid).sort()).toEqual([
    "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
    "ffffffff-6666-4666-8666-ffffffffffff",
  ]);
}, 120_000);

// ── 4. 错误语义不许因为异步化而退化（根因 C 的常驻回归在异步路径上的对应面）──
//
// herdr-fleet 的重试闸只看两样东西：attach 的**出口种类**（"empty"）和失败的
// **错误类型**（isDeterministicAttachFailure）。把 attach 换成 Promise 之后，
// 这两样必须逐字不变 —— reject 成裸 Error 或被 await 吞掉，devbox 上那场
// 「每 20–30s 重试一遍 197MB rollout」的风暴就会原样回来。

const asyncDir = path.join(tempRoot, "semantics");
fs.mkdirSync(asyncDir, { recursive: true });

function noTurnsJsonl(sid: string): string {
  // 合法 JSON 行，但一条 turn 都产不出（只有噪声行）—— devbox 上真实触发无限
  // 重试的那种文件。
  return (
    [
      { type: "mode", mode: "default", sessionId: sid, cwd: asyncDir },
      { type: "file-history-snapshot", messageId: "m1", snapshot: { trackedFileBackups: {} } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

function conversationJsonl(sid: string): string {
  return (
    [
      { type: "user", uuid: `u1-${sid}`, parentUuid: null, sessionId: sid, cwd: asyncDir, timestamp: "2026-09-18T03:00:00.000Z", message: { role: "user", content: "question" } },
      { type: "assistant", uuid: `a1-${sid}`, parentUuid: `u1-${sid}`, sessionId: sid, cwd: asyncDir, timestamp: "2026-09-18T03:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

test("异步 attach：零轮次会话仍是 empty 出口，长出真对话后能被接回来", async () => {
  const sid = "01111111-1111-4111-8111-111111111111";
  const file = path.join(asyncDir, `${sid}.jsonl`);
  fs.writeFileSync(file, noTurnsJsonl(sid));

  // 出口是 "empty" 而不是异常 —— herdr-fleet 据此走指纹跳过（skipTranscript），
  // 既不重试也不刷日志。
  expect(await attachHerdrTranscript(file, "claude")).toBe("empty");
  expect(await attachSessionAsync(file, "claude", { origin: "herdr" })).toEqual({
    sessionId: sid,
    status: "empty",
    turns: 0,
  });

  // 不是永久黑名单：CLI 往同一个文件**追加**出第一轮真对话（指纹变了）之后，
  // 就该照常镜像进来。
  fs.appendFileSync(file, conversationJsonl(sid));
  expect(await attachHerdrTranscript(file, "claude")).toBe("attached");
  expect(
    sqlite.getDB().prepare("SELECT origin FROM sessions WHERE id = ?").get(sid),
  ).toEqual({ origin: "herdr" });
});

test("异步发现：选中文件解析不出轮次 → 仍是确定性错误类型，不是裸 Error", async () => {
  const sid = "02222222-2222-4222-8222-222222222222";
  const file = path.join(asyncDir, `${sid}.jsonl`);
  fs.writeFileSync(file, noTurnsJsonl(sid));

  const thrown = await discoverLineageAsync(file, "claude").then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(CliTranscriptNoTurnsError);
  expect((thrown as InstanceType<typeof CliTranscriptNoTurnsError>).transcriptPath).toBe(file);
  // 这是判据本身：fleet 的重试闸只看这个函数。
  expect(isDeterministicAttachFailure(thrown)).toBe(true);
});

test("异步 attach：读不到 = 可重试类型；撞上 native 会话 = 确定性类型", async () => {
  const missing = path.join(asyncDir, "does-not-exist.jsonl");
  const unreadable = await attachSessionAsync(missing, "claude").then(
    () => null,
    (error: unknown) => error,
  );
  expect(unreadable).toBeInstanceOf(CliTranscriptUnreadableError);
  // 可重试的那一类不能被误判成确定性，否则临时故障会被永久跳过。
  expect(isDeterministicAttachFailure(unreadable)).toBe(false);

  // native 会话撞了同一个 id：换多少次时机都还是撞 → 确定性。
  const sid = "03333333-3333-4333-8333-333333333333";
  const file = path.join(asyncDir, `${sid}.jsonl`);
  fs.writeFileSync(file, conversationJsonl(sid));
  sqlite
    .getDB()
    .prepare(
      `INSERT INTO sessions (id, title, root_node_id, created_at, updated_at, context_mode, origin)
       VALUES (?, 'native', ?, 1, 1, 'chat', 'user')`,
    )
    .run(sid, `root-${sid}`);
  const conflict = await attachSessionAsync(file, "claude", { origin: "herdr" }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(conflict).toBeInstanceOf(NativeSessionConflictError);
  expect(isDeterministicAttachFailure(conflict)).toBe(true);
});
