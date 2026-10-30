// Herdr 窗格 → Web Push 的状态跟踪（纯函数）。输入是 lib/herdr-console buildHerdrConsole
// 的窗格列表（与页面同一套派生：hook > transcript > herdr 自己的探测），输出这次变化里：
//   raised   新出现的「需要你」交互（同一窗格同一个交互只出一次）
//   left     刚离开「需要你」的窗格（服务端过一个抖动窗口再确认后收回通知）
//   working  在干活的窗格（「已完成」待裁决作废）
//   ended    从干活转到空闲 / 完成（「已完成」开始 60s 延迟）
// 服务端接线与发送在 lib/server/herdr-push.ts。
import { herdrAttentionText, type HerdrConsolePane, type HerdrLane } from "./herdr-console";
import { herdrPanePrompt } from "./herdr-ui";

export type HerdrPushTrack = {
  lane: HerdrLane;
  working: boolean;
  /** 当前「需要你」的交互键；不在 need 为 null。 */
  interaction: string | null;
  /** 已经推过（或判过不推）的交互键：同一个交互只处理一次。离开 need 后保留，供抖动回来时认。 */
  handled: string | null;
  leftNeedAt: number | null;
};

export type HerdrPushState = Map<string, HerdrPushTrack>;

export type HerdrRaised = {
  pane: HerdrConsolePane;
  interaction: string;
  where: string;
  text: string;
};

export type HerdrPushDiff = {
  state: HerdrPushState;
  raised: HerdrRaised[];
  left: string[];
  working: string[];
  ended: HerdrConsolePane[];
  /** 此刻在「需要你」的窗格（角标计数用）。 */
  need: { paneId: string; sessionId: string | null }[];
};

/** 抖动窗口：离开 need 这么久之内又回来、且还是同一个交互 → 视为同一次卡住，不重推也不收回。
 *  与页面 HERDR_ATTENTION_FLICKER_MS 同量级。 */
export const HERDR_PUSH_FLICKER_MS = 8_000;
/** 进程里第一次算：只推这么新的「需要你」（重启前就挂着的大多推过了）。 */
export const HERDR_PUSH_FRESH_MS = 60_000;

function hashString(text: string): string {
  // djb2：只用来区分「是不是同一张卡」，不需要抗碰撞。
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 交互键：结构化卡用 tool_use_id（没有就用卡片内容的指纹）；只靠读屏的 blocked 统一记 screen。 */
export function herdrInteractionKey(pane: HerdrConsolePane): string {
  const prompt = herdrPanePrompt(pane.view);
  if (!prompt) return "screen";
  if (prompt.toolUseId) return `tu:${prompt.toolUseId}`;
  try {
    return `card:${hashString(JSON.stringify(prompt.prompt))}`;
  } catch {
    return "card";
  }
}

export function herdrWhere(pane: Pick<HerdrConsolePane, "workspaceLabel" | "tabLabel">): string {
  return `${pane.workspaceLabel} · ${pane.tabLabel}`;
}

export function diffHerdrPush(
  prev: HerdrPushState | null,
  panes: readonly HerdrConsolePane[],
  now: number,
): HerdrPushDiff {
  const state: HerdrPushState = new Map();
  const out: HerdrPushDiff = { state, raised: [], left: [], working: [], ended: [], need: [] };
  for (const pane of panes) {
    if (pane.lane === "off" || pane.lane === "shell") continue;
    const before = prev?.get(pane.key);
    const working = pane.lane === "run";
    const track: HerdrPushTrack = {
      lane: pane.lane,
      working,
      interaction: null,
      handled: before?.handled ?? null,
      leftNeedAt: before?.leftNeedAt ?? null,
    };
    state.set(pane.key, track);
    if (working) out.working.push(pane.key);
    else if (before?.working && pane.lane === "idle") out.ended.push(pane);

    if (pane.lane === "need") {
      out.need.push({ paneId: pane.paneId, sessionId: pane.sessionId });
      const key = herdrInteractionKey(pane);
      track.interaction = key;
      track.leftNeedAt = null;
      // 从别的泳道回到 need：抖动窗口外回来的是新的一次卡住（只靠读屏的窗格每次键都是
      // screen，不清就永远不推第二次）；窗口内回来的同一张卡仍算同一次。
      const returning = before !== undefined && before.lane !== "need";
      if (returning && (before.leftNeedAt == null || now - before.leftNeedAt >= HERDR_PUSH_FLICKER_MS)) {
        track.handled = null;
      }
      // 同一个交互只处理一次：还挂着的、或抖动回来的同一张卡都不再出。
      if (track.handled === key) continue;
      track.handled = key;
      // 第一次算（进程刚起）：只认刚冒出来的。
      if (!prev && (pane.activityAt == null || now - pane.activityAt > HERDR_PUSH_FRESH_MS)) continue;
      out.raised.push({ pane, interaction: key, where: herdrWhere(pane), text: herdrAttentionText(pane) });
      continue;
    }
    if (before?.lane === "need") {
      track.leftNeedAt = now;
      out.left.push(pane.key);
    } else if (track.leftNeedAt != null && now - track.leftNeedAt >= HERDR_PUSH_FLICKER_MS) {
      // 抖动窗口过了：这个交互彻底翻篇，同一张卡（理论上不会）再出现也算新的。
      track.leftNeedAt = null;
      track.handled = null;
    }
  }
  // 整个窗格没了（关掉 / 离线）：也算离开 need。
  if (prev) {
    for (const [key, before] of prev) {
      if (!state.has(key) && before.lane === "need") out.left.push(key);
    }
  }
  return out;
}
