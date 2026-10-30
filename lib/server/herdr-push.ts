import "server-only";
import fs from "node:fs";
import { buildHerdrConsole, type HerdrConsolePane } from "../herdr-console";
import { diffHerdrPush, herdrWhere, HERDR_PUSH_FLICKER_MS, type HerdrPushState } from "../herdr-push-watch";
import { buildHerdrPushPayload } from "../push";
import { DoneScheduler, doneDelayFromEnv, type DoneProbe, type DoneTimers } from "../push-done";
import { scanTranscriptBackground } from "../transcript-background";
import type { HerdrFleetResponse } from "../herdr-ui";
import { getHookRecord, listHookSummaries } from "./agent-hooks/store";
import type { AgentHookRecord } from "./agent-hooks/types";
import { subscribeCliSync } from "./cli-sync-events";
import { tapConsoleChanges } from "./console-events";
import { getHerdrFleetService } from "./herdr-fleet";
import { fire, gateFor, onPresenceSeen, pushReachable, pushTimers, releaseDedupe } from "./push";

// Herdr 窗格的 Web Push：「需要你」立即推、处理掉就收回；「已完成」走 60s 延迟裁决
// （lib/push-done.ts），结束时还有后台任务就等它们回报完的那一轮。
//
// 触发点只旁听、不改 hook 路由：Herdr socket 变化（fleet.subscribe）、hook 写入
// （console-events 的 notifyConsoleChange 旁听）、transcript 镜像重导（cli-sync 事件）。
// 任一发生都合并到 COALESCE_MS 后算一次——与页面同一套派生（buildHerdrConsole），所以
// 推送里的「需要你」与总览泳道口径一致。
//
// 所有状态挂 globalThis（理由同 ./push.ts 顶部注释）；定时器只在内存里，重启丢了可以接受，
// 重启后第一次算只认刚冒出来的交互，不会把挂着的卡再推一遍。

export const HERDR_PUSH_COALESCE_MS = 200;
/** transcript 尾扫上限：后台任务的启动行通常就在最近几轮里。 */
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

type DoneInfo = { paneKey: string };

export type HerdrPushDeps = {
  /** 当前窗格（与页面同一套派生）。Herdr 不可用时返回 null —— 断线重连不能被当成「全都处理掉了」。 */
  panes: (now: number) => HerdrConsolePane[] | null;
  hookRecord: (sessionId: string) => AgentHookRecord | null;
  transcriptLines: (path: string) => string[] | null;
};

function readTail(file: string, max = TRANSCRIPT_TAIL_BYTES): string[] | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    // 从中间切进来的第一行是半行，丢掉。
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export const realHerdrPushDeps: HerdrPushDeps = {
  panes: (now) => {
    const fleet = getHerdrFleetService().fleet() as unknown as HerdrFleetResponse;
    if (!fleet.available) return null;
    return buildHerdrConsole(fleet, listHookSummaries(), now);
  },
  hookRecord: getHookRecord,
  transcriptLines: (path) => readTail(path),
};

export class HerdrPushWatcher {
  private state: HerdrPushState | null = null;
  private panes = new Map<string, HerdrConsolePane>();
  /** 推过「需要你」、还没收回的窗格。 */
  private readonly notified = new Map<string, { paneId: string; sessionId: string | null; where: string }>();
  private readonly resolveTimers = new Map<string, unknown>();
  private scheduled = false;
  readonly done: DoneScheduler<DoneInfo>;

  constructor(
    private readonly deps: HerdrPushDeps = realHerdrPushDeps,
    private readonly timers: DoneTimers = pushTimers,
    /** 推送出口与角标上报（测试可换）。 */
    private readonly onNeed: (need: { paneId: string; sessionId: string | null }[]) => void = publishNeed,
  ) {
    this.done = new DoneScheduler<DoneInfo>({
      timers,
      delayMs: () => doneDelayFromEnv(),
      probe: (_key, info) => this.probeDone(info.paneKey),
      deliver: (_key, info) => this.sendDone(info.paneKey),
    });
  }

  /** 变化通知入口：合并窗口内只算一次。 */
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.timers.setTimeout(() => {
      this.scheduled = false;
      try {
        this.evaluate();
      } catch (err) {
        console.warn("[push] herdr 推送评估失败：", err);
      }
    }, HERDR_PUSH_COALESCE_MS);
  }

  evaluate(): void {
    // 没人收：不算（fleet() 要 stat 一遍绑定表），状态也清掉——重新有人收时从头认。
    if (!pushReachable()) {
      this.state = null;
      this.onNeed([]);
      return;
    }
    const now = this.timers.now();
    const panes = this.deps.panes(now);
    if (!panes) return;
    const diff = diffHerdrPush(this.state, panes, now);
    this.state = diff.state;
    this.panes = new Map(panes.map((p) => [p.key, p]));
    this.onNeed(diff.need);

    for (const key of diff.working) this.done.working(doneKey(key));
    // 转成「需要你」：那条推送会顶掉「已完成」，待裁决的作废。
    for (const pane of panes) if (pane.lane === "need") this.done.cancel(doneKey(pane.key));
    for (const pane of diff.ended) this.done.ended(doneKey(pane.key), { paneKey: pane.key }, pane.sessionId);

    for (const key of diff.left) this.scheduleResolve(key);
    for (const raised of diff.raised) {
      this.cancelResolve(raised.pane.key);
      const { pane } = raised;
      if (!gateFor("waiting", pane.sessionId, herdrDedupeId(pane.paneId))) continue;
      this.notified.set(pane.key, { paneId: pane.paneId, sessionId: pane.sessionId, where: raised.where });
      fire(buildHerdrPushPayload({ kind: "waiting", paneId: pane.paneId, sessionId: pane.sessionId, where: raised.where, text: raised.text }));
    }
  }

  // ── 收回 ──────────────────────────────────────────────────────────────────
  //
  // 离开「需要你」先等一个抖动窗口（hook TTL / 探测抖动会让窗格短暂掉出 need），到点还不在
  // need 才收回：同 tag 发一条 resolved，SW 静默替换后关掉（public/sw.js）。推送服务按
  // Topic（= tag 的 hash）只留最新一条，手机离线时这条也会顶掉还没送达的「需要你」。

  private scheduleResolve(key: string): void {
    if (!this.notified.has(key)) return;
    this.cancelResolve(key);
    this.resolveTimers.set(key, this.timers.setTimeout(() => {
      this.resolveTimers.delete(key);
      this.resolveNow(key);
    }, HERDR_PUSH_FLICKER_MS));
  }

  private cancelResolve(key: string): void {
    const timer = this.resolveTimers.get(key);
    if (timer === undefined) return;
    this.timers.clearTimeout(timer);
    this.resolveTimers.delete(key);
  }

  private resolveNow(key: string): void {
    const note = this.notified.get(key);
    if (!note) return;
    if (this.state?.get(key)?.lane === "need") return; // 又回到 need：新卡已原地替换，或还是同一张
    this.notified.delete(key);
    releaseDedupe("waiting", herdrDedupeId(note.paneId));
    if (!pushReachable()) return;
    fire(buildHerdrPushPayload({ kind: "resolved", paneId: note.paneId, sessionId: note.sessionId, where: note.where }));
  }

  // ── 已完成 ────────────────────────────────────────────────────────────────

  private hookFor(pane: HerdrConsolePane): AgentHookRecord | null {
    const sessionId = pane.view?.hook?.sessionId ?? pane.view?.binding?.sessionId;
    return sessionId ? this.deps.hookRecord(sessionId) : null;
  }

  /** 到点现场：窗格还在不在、在干嘛、后台任务。 */
  probeDone(paneKey: string): DoneProbe {
    const pane = this.panes.get(paneKey);
    if (!pane) return { status: "gone" };
    if (pane.lane === "run") return { status: "working" };
    if (pane.lane !== "idle") return { status: "gone" };
    const hook = this.hookFor(pane);
    const transcript = pane.view?.binding?.transcriptPath ?? hook?.transcriptPath ?? null;
    const lines = transcript ? this.deps.transcriptLines(transcript) : null;
    if (lines) {
      const bg = scanTranscriptBackground(lines);
      return { status: "done", background: bg.running.length > 0, wokeByTask: bg.wokeByTask };
    }
    // 读不到 transcript：退回 hook 的子 agent 名单（SubagentStart 进、SubagentStop 出）。
    return { status: "done", background: (hook?.subagents.length ?? 0) > 0 };
  }

  private sendDone(paneKey: string): void {
    const pane = this.panes.get(paneKey);
    if (!pane) return;
    if (!gateFor("done", pane.sessionId, herdrDedupeId(pane.paneId))) return;
    const hook = this.hookFor(pane);
    fire(buildHerdrPushPayload({
      kind: "done",
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      where: herdrWhere(pane),
      text: hook?.lastAssistantMessage ?? null,
    }));
  }
}

function doneKey(paneKey: string): string {
  return `herdr:${paneKey}`;
}

function herdrDedupeId(paneId: string): string {
  return `herdr:${paneId}`;
}

type Shared = typeof globalThis & {
  trellisHerdrPush?: HerdrPushWatcher;
  trellisHerdrNeed?: { paneId: string; sessionId: string | null }[];
};
const shared = globalThis as Shared;

/** 角标：./push.ts 的 currentBadge 从 globalThis 读（不 import 这里，免得成环）。 */
function publishNeed(need: { paneId: string; sessionId: string | null }[]): void {
  shared.trellisHerdrNeed = need;
}

/** instrumentation 启动时调一次（幂等）。TRELLIS_HERDR_PUSH=off 关闸。 */
export function startHerdrPushWatch(): HerdrPushWatcher | null {
  if (process.env.TRELLIS_HERDR_PUSH === "off") return null;
  if (shared.trellisHerdrPush) return shared.trellisHerdrPush;
  const watcher = (shared.trellisHerdrPush = new HerdrPushWatcher());
  const fleet = getHerdrFleetService();
  void fleet.ensureStarted();
  fleet.subscribe(() => watcher.schedule());
  tapConsoleChanges(() => watcher.schedule());
  subscribeCliSync({
    onEvent: (event) => { if (event.type === "session_updated") watcher.schedule(); },
    onClose: () => {},
  });
  onPresenceSeen((sessionId) => watcher.done.seen(sessionId));
  watcher.schedule();
  return watcher;
}
