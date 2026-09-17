import { formatDuration } from "@/lib/format-duration";
import type { ToolNode } from "@/lib/tool-tree";
import type { WorkflowAgentEntry, WorkflowPhaseEntry } from "@/lib/types";

// Workflow 进度面板的**纯数据层**：把 `workflow_progress` 全量快照（facts #47）
// 揉成组件直接铺得出来的形状。放在 lib 里的理由只有一个 —— 这里每一条都是
// 产品决定（状态词表、阶段默认展开、分栏与折叠阈值），它们该被单测钉死，而
// 不是埋在 JSX 里靠截图守。

/** 行状态的闭集。CLI 侧的 `state` 是开放字符串，入口只有 agentStateOf()。 */
export type AgentState = "done" | "running" | "queued" | "failed" | "killed";

/** 卡片整体状态。interrupted（流断了还挂着 running）并入 killed —— 中性灰。 */
export type WorkflowStatus = "running" | "completed" | "failed" | "killed";

const STATE_WORDS: Record<string, AgentState> = {
  done: "done",
  completed: "done",
  failed: "failed",
  error: "failed",
  killed: "killed",
  cancelled: "killed",
  canceled: "killed",
  aborted: "killed",
  queued: "queued",
  pending: "queued",
};

/**
 * CLI 的 state 字符串 → 五态。
 *
 * 白名单之外（"start" / "running" / 将来新加的词）一律算运行中：快照里存在
 * 这一行就说明它至少被调度过，把未知词当成「完成」才是会骗人的那一侧。
 */
export function agentStateOf(state: string | undefined | null): AgentState {
  if (!state) return "running";
  return STATE_WORDS[state.trim().toLowerCase()] ?? "running";
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  done: "已完成",
  running: "运行中",
  queued: "排队中",
  failed: "已失败",
  killed: "已终止",
};

export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "已失败",
  killed: "已终止",
};

/** 超过这个数量的阶段自动分栏（auto-fill grid，保持 index 顺序）。 */
export const GRID_THRESHOLD = 8;
/** 分栏之后仍然超过这么多行，尾部连续的安静行折起来。 */
export const MAX_ROWS = 12;
/** 一栏的最小宽与栏间距 —— 和 WorkflowView 里那条 auto-fill grid 是同一组数。 */
export const AGENT_COL_MIN = 280;
export const AGENT_COL_GAP = 16;

/**
 * 容器宽 → CSS `auto-fill, minmax(280px, 1fr)` 实际排得出几栏。
 *
 * 量不到（SSR、还没挂载、宽度是 0）按 2 栏 —— 桌面是常态，先按它铺，
 * ResizeObserver 一量到真宽度就会纠正。
 */
export function columnsForWidth(width: number | null | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return 2;
  return Math.max(
    1,
    Math.floor((width + AGENT_COL_GAP) / (AGENT_COL_MIN + AGENT_COL_GAP)),
  );
}

export type WorkflowAgentVM = {
  entry: WorkflowAgentEntry;
  state: AgentState;
  key: string;
};

export type WorkflowPhaseVM = {
  key: string;
  title: string;
  agents: WorkflowAgentVM[];
  total: number;
  done: number;
  running: number;
  queued: number;
  failed: number;
  killed: number;
  durationMs: number | null;
  /** "4/6" / "6/6 完成" */
  countText: string;
  /** "1 运行中 · 3m 42s" / "全部排队中" / "2m 12s" */
  metaText: string;
  /** 含未完成（运行中 / 失败 / 已终止）agent 的阶段默认展开。 */
  defaultOpen: boolean;
};

export type WorkflowVM = {
  status: WorkflowStatus;
  phases: WorkflowPhaseVM[];
  total: number;
  done: number;
  failed: number;
  running: number;
  /** 0–100，进度轨宽度。 */
  percent: number;
  /** false = 没有任何阶段 / agent 明细，正文得降级。 */
  hasDetail: boolean;
};

// ── 快照形状守卫 ──────────────────────────────────────────────────────────
//
// `workflow_progress` 是 CLI 直接塞进来、原样落库的 JSON，没人替我们校过形状。
// 类型声明说它是数组，运行时不保证：一个非数组的值会让 `.filter is not a
// function` 把整条动线炸成空白页 —— 比「这一行看不懂」坏得多。
//
// 纪律是「一处不合规，整份快照作废」，而不是把坏条目筛掉接着画：半份快照算出
// 来的 4/11 是骗人的数字，退回 RawView 至少把原始 JSON 摆在眼前，能排查。
//
// 唯一的例外是**将来新增的 entry 类型**：type 不是这两种的条目照旧忽略
// （types.ts 上那条约定），那不是畸形，是前向兼容。

function isPhaseEntry(e: unknown): e is WorkflowPhaseEntry {
  if (typeof e !== "object" || e === null) return false;
  const p = e as Partial<WorkflowPhaseEntry>;
  return (
    p.type === "workflow_phase" &&
    typeof p.title === "string" &&
    typeof p.index === "number"
  );
}

function isAgentEntry(e: unknown): e is WorkflowAgentEntry {
  if (typeof e !== "object" || e === null) return false;
  const a = e as Partial<WorkflowAgentEntry>;
  return a.type === "workflow_agent" && typeof a.label === "string";
}

function entryShapeOk(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const type = (e as { type?: unknown }).type;
  if (type === "workflow_phase") return isPhaseEntry(e);
  if (type === "workflow_agent") return isAgentEntry(e);
  return true;
}

/**
 * 这份快照能不能信。**表头、正文、面包屑共用的那一个守卫** —— 三处各读各的
 * 快照，只守其中一处等于没守。
 *
 * 没有快照（undefined / null）不算畸形：那是「还没来」或者「老 daemon 不发」，
 * 表头会照常出现并注明「暂无阶段明细」。
 */
export function hasValidWorkflowProgress(node: ToolNode): boolean {
  const raw: unknown = node.meta.workflowProgress;
  if (raw === undefined || raw === null) return true;
  return Array.isArray(raw) && raw.every(entryShapeOk);
}

function entriesOf(node: ToolNode): unknown[] {
  const raw: unknown = node.meta.workflowProgress;
  return Array.isArray(raw) ? raw : [];
}

export function phasesOf(node: ToolNode): WorkflowPhaseEntry[] {
  return entriesOf(node).filter(isPhaseEntry);
}

export function agentsOf(node: ToolNode): WorkflowAgentEntry[] {
  return entriesOf(node).filter(isAgentEntry);
}

export function hasWorkflowDetail(node: ToolNode): boolean {
  return phasesOf(node).length > 0 || agentsOf(node).length > 0;
}

/**
 * 卡片状态。
 *
 * - 还在跑 + 流还活着 → running；流断了还挂着 running → killed（「已终止」，
 *   跟 ToolRow 的「已中断」同一个判断，永远好过假装它还在跑）。
 * - 工具本身报错、task_updated 说 failed、或者任何一个 agent 失败 → failed。
 *   最后一条是有意的：全绿的表头配一个红 agent 行是谎。
 */
export function workflowStatusOf(node: ToolNode, live: boolean): WorkflowStatus {
  if (node.running) return live ? "running" : "killed";
  if (node.call.status === "error" || node.meta.status === "failed") {
    return "failed";
  }
  if (agentsOf(node).some((a) => agentStateOf(a.state) === "failed")) {
    return "failed";
  }
  return "completed";
}

/** 快照 → 阶段树。loose（没归属阶段的）agent 单独成段，不会消失。 */
export function buildWorkflowVM(node: ToolNode, live: boolean): WorkflowVM {
  const phaseEntries = phasesOf(node);
  const agentEntries = agentsOf(node);
  const known = new Set(phaseEntries.map((p) => p.index));

  const vm = (a: WorkflowAgentEntry): WorkflowAgentVM => ({
    entry: a,
    state: agentStateOf(a.state),
    key: `${a.index}-${a.agentId ?? a.label}`,
  });

  const phases: WorkflowPhaseVM[] = phaseEntries.map((p) =>
    buildPhase(
      `p${p.index}`,
      p.title,
      agentEntries.filter((a) => a.phaseIndex === p.index).map(vm),
    ),
  );
  const loose = agentEntries
    .filter((a) => a.phaseIndex === undefined || !known.has(a.phaseIndex))
    .map(vm);
  if (loose.length > 0) {
    phases.push(
      buildPhase("loose", phaseEntries.length > 0 ? "其他" : "agent", loose),
    );
  }

  const all = agentEntries.map(vm);
  const done = all.filter((a) => a.state === "done").length;
  const failed = all.filter((a) => a.state === "failed").length;
  const running = all.filter((a) => a.state === "running").length;
  return {
    status: workflowStatusOf(node, live),
    phases,
    total: all.length,
    done,
    failed,
    running,
    percent: all.length === 0 ? 0 : Math.round((done / all.length) * 100),
    hasDetail: phaseEntries.length > 0 || agentEntries.length > 0,
  };
}

function buildPhase(
  key: string,
  title: string,
  agents: WorkflowAgentVM[],
): WorkflowPhaseVM {
  const count = (s: AgentState) => agents.filter((a) => a.state === s).length;
  const total = agents.length;
  const done = count("done");
  const running = count("running");
  const queued = count("queued");
  const failed = count("failed");
  const killed = count("killed");
  const durationMs = phaseDurationMs(agents);
  const dur = durationMs === null ? null : formatDuration(durationMs);

  const meta: string[] = [];
  if (running > 0) meta.push(`${running} 运行中`);
  if (failed > 0) meta.push(`${failed} 已失败`);
  if (killed > 0) meta.push(`${killed} 已终止`);
  if (queued > 0 && queued === total) meta.push("全部排队中");
  else if (queued > 0) meta.push(`${queued} 排队中`);
  if (dur && !(queued === total && total > 0)) meta.push(dur);

  return {
    key,
    title,
    agents,
    total,
    done,
    running,
    queued,
    failed,
    killed,
    durationMs,
    countText: total > 0 && done === total ? `${done}/${total} 完成` : `${done}/${total}`,
    metaText: meta.join(" · "),
    defaultOpen: running + failed + killed > 0,
  };
}

/**
 * 阶段用时取墙钟（最早开始 → 最后一次活动），不是各 agent 耗时之和 —— 一个
 * 阶段里 16 个 agent 并行跑 1 分钟是 1 分钟，不是 16 分钟。时间戳缺失时退回
 * 求和（老快照只有 durationMs）。
 */
function phaseDurationMs(agents: WorkflowAgentVM[]): number | null {
  let min = Infinity;
  let max = -Infinity;
  for (const { entry } of agents) {
    const start = entry.startedAt ?? entry.queuedAt;
    if (start === undefined) continue;
    const end =
      entry.lastProgressAt ??
      (entry.durationMs !== undefined ? start + entry.durationMs : undefined);
    min = Math.min(min, start);
    if (end !== undefined) max = Math.max(max, end);
  }
  if (min !== Infinity && max !== -Infinity && max >= min) return max - min;
  const sum = agents.reduce((n, a) => n + (a.entry.durationMs ?? 0), 0);
  return sum > 0 ? sum : null;
}

// ── 规模：分栏与尾部折叠 ──────────────────────────────────────────────────

/** 安静行 = 没有人在等它出结果的行，只有它们能被折进「… 还有 n 个」。 */
function quiet(a: WorkflowAgentVM): boolean {
  return a.state !== "running" && a.state !== "failed";
}

export type AgentLayout = {
  /** 分栏 grid（auto-fill minmax(280px,1fr)），保持 index 顺序。 */
  grid: boolean;
  visible: WorkflowAgentVM[];
  folded: WorkflowAgentVM[];
  /** 折叠按钮文案；folded 为空时是空串。 */
  moreLabel: string;
  lessLabel: string;
};

/**
 * @param columns 容器**实际**排得出的栏数（columnsForWidth 量出来的）。
 *   12 行预算说的是屏幕上的行，不是「假装永远两栏」算出来的行：同样 24 个
 *   agent，桌面两栏是 12 行该全铺，手机一栏是 24 行该折尾。缺省 2 = SSR 与
 *   首帧的桌面假设。
 */
export function layoutAgents(
  agents: WorkflowAgentVM[],
  columns = 2,
): AgentLayout {
  const grid = agents.length > GRID_THRESHOLD;
  const cols = grid
    ? Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 2))
    : 1;
  const rows = (n: number) => Math.ceil(n / cols);
  let fold = 0;
  if (rows(agents.length) > MAX_ROWS) {
    // 折叠按钮自己也占一整行 —— 预算因此是 MAX_ROWS - 1 行。
    const budget = (MAX_ROWS - 1) * cols;
    let tail = 0;
    while (tail < agents.length && quiet(agents[agents.length - 1 - tail])) {
      tail++;
    }
    fold = Math.max(0, Math.min(tail, agents.length - budget));
  }
  const folded = fold > 0 ? agents.slice(agents.length - fold) : [];
  return {
    grid,
    visible: fold > 0 ? agents.slice(0, agents.length - fold) : agents,
    folded,
    moreLabel: folded.length > 0 ? `… 还有 ${foldSummary(folded)}` : "",
    lessLabel: folded.length > 0 ? `收起 ${folded.length} 个` : "",
  };
}

// "4 个已完成" / "4 个（2 已完成 / 2 排队中）"
function foldSummary(folded: WorkflowAgentVM[]): string {
  const order: AgentState[] = ["done", "queued", "killed", "running", "failed"];
  const parts = order
    .map((s) => [s, folded.filter((a) => a.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${AGENT_STATE_LABEL[s]}`);
  if (parts.length === 1) {
    return `${folded.length} 个${AGENT_STATE_LABEL[folded[0].state]}`;
  }
  return `${folded.length} 个（${parts.join(" / ")}）`;
}

// ── agent 元信息面板 ──────────────────────────────────────────────────────

/** 时间戳 → 本地时分秒。非法 / 缺失给「—」，不猜。 */
export function formatClock(ts: number | undefined | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 模型短名："claude-opus-5[1m]" → "opus-5[1m]"。只砍确定无信息量的部分
 * （厂商前缀、日期后缀），不做 4-5 → 4.5 这类猜测性美化。
 */
export function shortModelName(model: string | undefined): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}(?=$|\[)/, "") || null;
}

export type DetailRow = { label: string; value: string; title?: string };

/** 点开 agent 行看到的键值面板。顺序即参考稿顺序。 */
export function agentDetailRows(
  agent: WorkflowAgentVM,
  phaseTitle: string,
): DetailRow[] {
  const a = agent.entry;
  const model = a.fallbackModel
    ? {
        value: `${shortModelName(a.fallbackModel)}（降级）`,
        title: `降级自 ${a.model ?? "—"}`,
      }
    : { value: shortModelName(a.model) ?? "—" };
  return [
    { label: "阶段", value: phaseTitle || "—" },
    { label: "模型", value: model.value, title: model.title },
    { label: "尝试", value: `第 ${a.attempt ?? 1} 次` },
    { label: "状态", value: AGENT_STATE_LABEL[agent.state] },
    { label: "排队于", value: formatClock(a.queuedAt) },
    { label: "开始于", value: formatClock(a.startedAt) },
    { label: "最近活动", value: formatClock(a.lastProgressAt) },
    {
      label: "耗时",
      value: a.durationMs !== undefined ? formatDuration(a.durationMs) : "—",
    },
    { label: "token", value: a.tokens !== undefined ? String(a.tokens) : "—" },
    {
      label: "工具调用",
      value: a.toolCalls !== undefined ? String(a.toolCalls) : "—",
    },
  ];
}
