import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getDB } from "./sqlite";

// ── codex rollout（~/.codex/sessions）的 lineage/分叉引擎 ─────────────────────
//
// claude 侧的镜像（cli-fork.ts），但两家 transcript 结构根本不同：
//   · claude jsonl 每行带 uuid/parentUuid 链 → 前缀构造沿链上溯（keepUuidChain）；
//   · codex rollout 是 {timestamp,type,payload} 的扁平 append-only 日志，没有
//     uuid 链 → 节点↔轮次的映射用「第 k 条 user message 的序号（ordinal）」，
//     前缀构造 = 按行截断到第 k+1 条 user message 之前。
// append-only 是 ordinal 稳定性的根基：resume 追加写回同一文件、compaction 只
// append `compacted` 标记行（不重写历史），所以任意时刻数出来的序号不漂移。
// 2026-07-26 实测钉死的事实（详见 progress）：
//   · `codex exec resume <sid>` 非交互可用，thread_id 不变、追加同文件；
//   · codex 按文件系统扫 rollout 找 sid，不查它自己的 sqlite 索引——手工构造的
//     前缀文件（新 UUID + 截断历史）被完整采信（暗号验证通过）；
//   · reasoning 行的 encrypted_content 丢弃不影响 resume。

const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

// sid → rollout 路径缓存。命中后仍 existsSync 验一次（文件可能被清）。
const rolloutPathCache = new Map<string, string>();

// claude 的 claudeSessionPath 可从 (sid, cwd) 确定性推导；codex 路径嵌着创建
// 日期（YYYY/MM/DD/rollout-<ts>-<sid>.jsonl），只能扫盘。目录按日期组织，从新
// 到旧扫、命中即停——常用 session 都在最近几天，实际开销一两个 readdir。
export function findCodexRolloutPath(sid: string): string | null {
  const cached = rolloutPathCache.get(sid);
  if (cached) {
    if (fs.existsSync(cached)) return cached;
    rolloutPathCache.delete(sid);
  }
  const suffix = `-${sid}.jsonl`;
  try {
    const numericDesc = (a: string, b: string) => Number(b) - Number(a);
    for (const y of fs.readdirSync(SESSIONS_ROOT).filter(isNumericDir).sort(numericDesc)) {
      const yDir = path.join(SESSIONS_ROOT, y);
      for (const m of fs.readdirSync(yDir).filter(isNumericDir).sort(numericDesc)) {
        const mDir = path.join(yDir, m);
        for (const d of fs.readdirSync(mDir).filter(isNumericDir).sort(numericDesc)) {
          const dDir = path.join(mDir, d);
          for (const f of fs.readdirSync(dDir)) {
            if (f.startsWith("rollout-") && f.endsWith(suffix)) {
              const full = path.join(dDir, f);
              rolloutPathCache.set(sid, full);
              return full;
            }
          }
        }
      }
    }
  } catch {
    // ~/.codex/sessions 不存在（未装 codex / 未跑过）→ 视同找不到
  }
  return null;
}

function isNumericDir(name: string): boolean {
  return /^\d+$/.test(name);
}

// resume id 自愈闸：rollout 被手动清理/迁移后，把死 id 喂给 `codex exec resume`
// 会硬失败——存在性检查失败就回落 fresh（与 claudeJsonlExists 同纪律）。
export function codexRolloutExists(sid: string): boolean {
  return findCodexRolloutPath(sid) !== null;
}

// 删除 trellis session/子树时清掉自有 rollout（best-effort；cli-import 域的
// 文件归用户，调用方负责不把它们传进来）。
export function deleteCodexRollout(sid: string): void {
  const p = findCodexRolloutPath(sid);
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // moved/deleted manually — best effort.
  }
  rolloutPathCache.delete(sid);
}

// ── rollout 解析 ─────────────────────────────────────────────────────────────

type RolloutLine = {
  lineIndex: number;
  raw: string;
  entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
};

// rollout 里「user message」行的判定。Responses API 的 function_call_output /
// reasoning 都是独立 item 类型不是 message，所以一轮之内 question 之后不会再出
// user message —— 这是「ordinal == 总数 ⇔ tip」成立的前提。注意注入类 user
// message（<user_instructions>/环境上下文）也计入序号：注入永远出现在该轮
// question 之前，所以「截到第 k+1 条 user message 之前」天然把下一轮的注入一起
// 截掉，序号语义不被注入破坏。
function isUserMessage(entry: RolloutLine["entry"]): boolean {
  if (entry.type !== "response_item") return false;
  const p = entry.payload;
  return !!p && p.type === "message" && p.role === "user";
}

function userMessageText(entry: RolloutLine["entry"]): string {
  const content = entry.payload?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join("");
}

function readRollout(p: string): RolloutLine[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const out: RolloutLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push({ lineIndex: i, raw: line, entry: JSON.parse(line) });
    } catch {
      // 半行写入（进程正被杀）——跳过该行，不让整个文件作废
    }
  }
  return out.length > 0 ? out : null;
}

// 数 user message 总数（= 最新轮的 ordinal，tip 判定的分母）。
function countUserMessages(lines: RolloutLine[]): number {
  let n = 0;
  for (const l of lines) if (isUserMessage(l.entry)) n++;
  return n;
}

// ── 前缀构造 ────────────────────────────────────────────────────────────────

// 在 sourcePath 里以「第 turnOrdinal 条 user message 所在的那一轮」为分叉点，
// 截出该轮结束为止的前缀，改写 session id 为新 UUID，写回同目录。
// 截断规则：保留到第 turnOrdinal+1 条 user message 之前（含分叉轮的完整
// assistant 响应/工具链）；随手剥掉尾部悬空的 turn_context / task 事件（属于
// 下一轮的 preamble，留着是脏元数据）。
export function buildCodexPrefixRollout(
  sourcePath: string,
  turnOrdinal: number,
): { newSid: string; rolloutPath: string } | null {
  const lines = readRollout(sourcePath);
  if (!lines || turnOrdinal < 1) return null;

  let seen = 0;
  let cutAt = lines.length; // 默认截到 EOF（分叉点就是 tip 的情形）
  for (let i = 0; i < lines.length; i++) {
    if (!isUserMessage(lines[i].entry)) continue;
    seen++;
    if (seen === turnOrdinal + 1) {
      cutAt = i;
      break;
    }
  }
  if (seen < turnOrdinal) return null; // ordinal 越界：映射失效，调用方降级线性

  let end = cutAt;
  while (end > 0) {
    const e = lines[end - 1].entry;
    const isPreamble =
      e.type === "turn_context" ||
      (e.type === "event_msg" && e.payload?.type === "task_started");
    if (!isPreamble) break;
    end--;
  }
  if (end === 0) return null;

  const newSid = crypto.randomUUID();
  const out: string[] = [];
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (l.entry.type === "session_meta" && l.entry.payload) {
      // 实测：改写 session_meta 的 id/session_id 即可让 codex 认领新 sid
      const payload = { ...l.entry.payload } as Record<string, unknown>;
      if ("id" in payload) payload.id = newSid;
      if ("session_id" in payload) payload.session_id = newSid;
      out.push(JSON.stringify({ ...l.entry, payload }));
    } else {
      out.push(l.raw);
    }
  }

  // 文件名时间戳按 codex 自己的格式（ISO8601 冒号换横杠，秒级）。
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const rolloutPath = path.join(path.dirname(sourcePath), `rollout-${ts}-${newSid}.jsonl`);
  try {
    fs.writeFileSync(rolloutPath, `${out.join("\n")}\n`, "utf8");
  } catch {
    return null;
  }
  rolloutPathCache.set(newSid, rolloutPath);
  return { newSid, rolloutPath };
}

// ── lineage 解析（nativeLineageForNode 的 codex 版）─────────────────────────

export type CodexLineage = {
  lineageSid: string;
  rolloutPath: string;
  // 该节点那轮在 rollout 里的 user-message 序号（nodes.codex_turn_ordinal）。
  // NULL = 回填缺失 → 该点分叉须降级线性 resume（宁线性不错切）。
  nodeTurnOrdinal: number | null;
  isRolloutTip: boolean;
};

// walk-up 找 lineage 头持有的 codex_session_id（lineage 头 = root 或 fork 节点，
// 自持 sid；线性子节点沿祖先链解析归属）。与 claude 版不同：不需要 cwd——codex
// rollout 路径与 cwd 无关，靠扫盘定位。
export function codexLineageForNode(nodeId: string): CodexLineage | null {
  const db = getDB();
  const node = db
    .prepare(
      "SELECT parent_id, codex_session_id, codex_turn_ordinal FROM nodes WHERE id = ?",
    )
    .get(nodeId) as
    | {
        parent_id: string | null;
        codex_session_id: string | null;
        codex_turn_ordinal: number | null;
      }
    | undefined;
  if (!node) return null;

  let lineageSid = node.codex_session_id;
  let parentId = node.parent_id;
  const parentStmt = db.prepare(
    "SELECT parent_id, codex_session_id FROM nodes WHERE id = ?",
  );
  while (!lineageSid && parentId) {
    const parent = parentStmt.get(parentId) as
      | { parent_id: string | null; codex_session_id: string | null }
      | undefined;
    if (!parent) break;
    lineageSid = parent.codex_session_id;
    parentId = parent.parent_id;
  }
  if (!lineageSid) return null;

  const rolloutPath = findCodexRolloutPath(lineageSid);
  if (!rolloutPath) return null;
  const lines = readRollout(rolloutPath);
  if (!lines) return null;
  const total = countUserMessages(lines);
  return {
    lineageSid,
    rolloutPath,
    nodeTurnOrdinal: node.codex_turn_ordinal,
    isRolloutTip:
      node.codex_turn_ordinal !== null && node.codex_turn_ordinal === total,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// done 后回填该节点的 turn ordinal（run-bus 钩子，best-effort；镜像
// backfillNativeTurnUuid）。rollout 落盘略滞后于 turn.completed → 轮询 ≤8×300ms。
// 防错配闸：从文件尾部找「最后一条包含节点 question 的 user message」记其序号
// ——prompt 无论被 system-prompt 前缀（chat）还是 anchor 包裹（project）都
// contains 原文；匹配不上就放弃：错的 ordinal 会让分叉切错位置，缺失只是降级
// 线性，后者严格更安全。适用 codex 的 chat（B-fork 等价路径）与 project。
export async function backfillCodexTurnOrdinal(nodeId: string): Promise<void> {
  const db = getDB();
  const row = db
    .prepare(
      `SELECT n.question, n.codex_turn_ordinal, s.origin
       FROM nodes n JOIN sessions s ON s.id = n.session_id
       WHERE n.id = ?`,
    )
    .get(nodeId) as
    | { question: string; codex_turn_ordinal: number | null; origin: string }
    | undefined;
  if (!row || row.codex_turn_ordinal !== null || row.origin !== "native") return;

  const q = row.question.trim();
  if (!q) return;
  for (let i = 0; i < 8; i++) {
    const lin = codexLineageForNode(nodeId);
    if (lin) {
      const lines = readRollout(lin.rolloutPath);
      if (lines) {
        let ordinal = 0;
        let match: number | null = null;
        for (const l of lines) {
          if (!isUserMessage(l.entry)) continue;
          ordinal++;
          if (userMessageText(l.entry).includes(q)) match = ordinal;
        }
        if (match !== null) {
          db.prepare(
            "UPDATE nodes SET codex_turn_ordinal = ? WHERE id = ? AND codex_turn_ordinal IS NULL",
          ).run(match, nodeId);
          return;
        }
      }
    }
    await sleep(300);
  }
}
