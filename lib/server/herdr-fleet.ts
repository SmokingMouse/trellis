import "server-only";
import type { Database } from "bun:sqlite";
import {
  attachHerdrTranscript,
  getHerdrBinding,
  listHerdrBindings,
  markHerdrPaneClosed,
  reconcileHerdrPane,
  reconcileHerdrSnapshot,
} from "./herdr-bindings";
import { HerdrClient } from "./herdr-client";
import type { HerdrPane } from "./herdr-types";
import type { HerdrInputDelivery } from "../herdr-input";
import type { HerdrScreenPrompt } from "../herdr-screen-parse";
import { IdempotencyCache } from "./idempotency";
import {
  isDeterministicAttachFailure,
  type CliAttachOutcome,
} from "./cli-attach";
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { canonicalPath } from "./canonical-path";
import { getDB } from "./sqlite";
import type { HerdrWorktree } from "../herdr-ui";
import { normalizeHerdrPath } from "../herdr-ui";
import {
  TranscriptPromptCache,
  type TranscriptPrompt,
} from "./agent-hooks/transcript-pending";
import { TranscriptModelCache } from "./agent-hooks/transcript-model";

// 路径规范化只此一家（./canonical-path）：fleet 这边 realpath、discover 那边
// os.homedir() 原样，正是根因 C 的形状。差别只在 fallback —— herdr 报上来的路径
// 可能带尾斜杠，解不出来时仍走 normalizeHerdrPath 削掉它。
function canonicalWorktreePath(value: string): string {
  const normalized = normalizeHerdrPath(value);
  return canonicalPath(normalized) || normalized;
}

function resolveGitBranch(checkout: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile("git", ["-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 2000 }, (error, stdout) => {
      const branch = error ? null : stdout.trim();
      resolve(branch && branch !== "HEAD" ? branch : null);
    });
  });
}

export const HERDR_BRANCH_TTL_MS = 60_000;
export const HERDR_BRANCH_FAILURE_TTL_MS = 10_000;
// 确定性跳过的 transcript 上限（和 resolveTranscriptPath 的 miss 缓存同量级）。
export const HERDR_SKIPPED_TRANSCRIPT_MAX = 1024;

type FleetOptions = {
  db?: Database;
  home?: string;
  attachClaude?: (transcriptPath: string) => void;
  attachTranscript?: (transcriptPath: string, agentKind: string) => void;
  attachHerdr?: (
    transcriptPath: string,
    agentKind: string,
  ) => Promise<CliAttachOutcome>;
  resolveBranch?: (checkout: string) => Promise<string | null>;
  branchNow?: () => number;
};

export class HerdrFleetService {
  private startPromise: Promise<void> | null = null;
  private bindingVersion = 0;
  private worktrees = new Map<string, HerdrWorktree>();
  private worktreeSignature = "";
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly branchCache = new Map<string, { branch: string | null; expiresAt: number; pending: boolean }>();
  private readonly attachedTranscriptKeys = new Set<string>();
  // 确定性跳过的 transcript → 跳过时的文件指纹。同样的字节重试永远是同样的结果，
  // 所以只有文件真的变了才值得再试一次（空会话长出第一轮对话就是这么被接回来的）。
  private readonly skippedTranscripts = new Map<string, string | null>();
  private readonly detach: () => void;
  // blocked 窗格的 transcript 待答（hook > transcript > 读屏 的中间一档），按 jsonl size+mtime 失效。
  private readonly transcriptPrompts = new TranscriptPromptCache();
  // claude 窗格当前模型（jsonl 最近一条 assistant 的 message.model），给 Herdr 输入框的只读 chip。
  private readonly transcriptModels = new TranscriptModelCache();
  // 窗格输入按 client_msg_id 去重（Outbox 重发 / 响应丢了重试不重复打字），见 ./idempotency.ts
  private readonly inputSends = new IdempotencyCache<HerdrInputDelivery>();

  constructor(
    readonly client = new HerdrClient(),
    private readonly options: FleetOptions = {},
  ) {
    this.detach = client.subscribe((change) => {
      const state = client.state;
      if (change.kind === "snapshot") {
        this.reconcileWorktrees();
        reconcileHerdrSnapshot(state.panes, state.agents, {
          ...this.options,
          attachTranscript: this.attachTranscript,
        });
        this.bindingVersion++;
      } else if (change.kind === "pane") {
        reconcileHerdrPane(
          change.pane,
          state.agents.find((agent) => agent.pane_id === change.pane.pane_id),
          { ...this.options, attachTranscript: this.attachTranscript },
        );
        this.bindingVersion++;
      } else if (change.kind === "pane-closed") {
        markHerdrPaneClosed(change.paneId, this.options.db);
        this.bindingVersion++;
      } else if (change.kind === "fleet" && this.metadataSignature() !== this.worktreeSignature) {
        this.reconcileWorktrees();
      }
      this.publish();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private cachedBranch(checkout: string): string | null {
    const now = this.options.branchNow ?? Date.now;
    const previous = this.branchCache.get(checkout);
    if (previous && (previous.pending || previous.expiresAt > now())) return previous.branch;
    const entry = { branch: previous?.branch ?? null, expiresAt: 0, pending: true };
    this.branchCache.set(checkout, entry);
    // Start subprocesses after event dispatch. Cache in-flight requests as well
    // as failures so duplicate workspaces and snapshots never multiply git calls.
    void Promise.resolve().then(() => (this.options.resolveBranch ?? resolveGitBranch)(checkout))
      .catch(() => null).then(branch => {
        if (this.stopped || this.branchCache.get(checkout) !== entry) return;
        entry.branch = branch && branch !== "HEAD" ? branch : null;
        entry.pending = false;
        entry.expiresAt = now() + (entry.branch ? HERDR_BRANCH_TTL_MS : HERDR_BRANCH_FAILURE_TTL_MS);
        this.reconcileWorktrees();
        this.bindingVersion++;
        this.publish();
      });
    return entry.branch;
  }

  private metadataSignature(): string {
    return JSON.stringify(this.client.state.workspaces.map(w => [w.workspace_id, w.worktree]));
  }

  private reconcileWorktrees(): void {
    this.worktreeSignature = this.metadataSignature();
    const metadata = this.client.state.workspaces.filter(w => w.worktree?.repo_root && w.worktree.checkout_path);
    const next = new Map<string, HerdrWorktree>();
    const activeCheckouts = new Set<string>();
    if (metadata.length) {
      const db = this.options.db ?? getDB();
      const branches = new Map<string, string>();
      const projectNames = new Map<string, string>();
      // Older isolated databases may not have the project/workspace schema.
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()) {
        const rows = db.query("SELECT path, git_branch FROM workspaces WHERE git_branch IS NOT NULL").all() as { path: string; git_branch: string }[];
        for (const row of rows) branches.set(canonicalWorktreePath(row.path), row.git_branch);
        if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()) {
          const names = db.query("SELECT w.path, p.name FROM workspaces w JOIN projects p ON p.id = w.project_id").all() as { path: string; name: string }[];
          for (const row of names) projectNames.set(canonicalWorktreePath(row.path), row.name);
        }
      }
      for (const workspace of metadata) {
        const wt = workspace.worktree!;
        const checkout = canonicalWorktreePath(wt.checkout_path);
        activeCheckouts.add(checkout);
        const branch = branches.get(checkout) || this.cachedBranch(checkout);
        const root = canonicalWorktreePath(wt.repo_root);
        next.set(workspace.workspace_id, { ...wt, repo_root: root, repo_name: projectNames.get(root) || wt.repo_name, checkout_path: checkout, git_branch: branch });
      }
    }
    // Workspace events refresh structure immediately; pane events do not resolve branches.
    this.worktrees = next;
    for (const checkout of this.branchCache.keys()) if (!activeCheckouts.has(checkout)) this.branchCache.delete(checkout);
  }

  private transcriptSignature(transcriptPath: string): string | null {
    try {
      const stat = statSync(transcriptPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  // 确定性失败 / 空会话：去掉 attach 去重 key（文件变了还要再试），转记进跳过表。
  // 日志只在**首次**记一条 —— 每 snapshot 一条 console.error 正是这个 bug 在
  // 运维侧的样子（24h 46 条同一行）。
  private skipTranscript(
    key: string,
    transcriptPath: string,
    signature: string | null,
    reason: string,
  ): void {
    this.attachedTranscriptKeys.delete(key);
    if (!this.skippedTranscripts.has(key)) {
      console.warn("[trellis] skipping Herdr transcript", transcriptPath, reason);
    }
    if (this.skippedTranscripts.size >= HERDR_SKIPPED_TRANSCRIPT_MAX) {
      this.skippedTranscripts.delete(this.skippedTranscripts.keys().next().value!);
    }
    this.skippedTranscripts.set(key, signature);
  }

  private readonly attachTranscript = (
    transcriptPath: string,
    agentKind: string,
  ): void => {
    const key = `${agentKind}:${transcriptPath}`;
    if (this.attachedTranscriptKeys.has(key)) return;
    // 每次 fleet snapshot（60s）和每个 pane 事件都会把同一批 transcript 重放一遍。
    // 上一轮已确定性失败且文件一个字节没变 → 直接返回，不 attach、不打日志。
    const signature = this.transcriptSignature(transcriptPath);
    if (this.skippedTranscripts.has(key)) {
      if (this.skippedTranscripts.get(key) === signature) return;
      this.skippedTranscripts.delete(key);
    }
    this.attachedTranscriptKeys.add(key);
    if (this.options.attachTranscript) {
      this.options.attachTranscript(transcriptPath, agentKind);
      return;
    }
    if (agentKind === "claude" && this.options.attachClaude) {
      this.options.attachClaude(transcriptPath);
      return;
    }
    const attach = this.options.attachHerdr ?? attachHerdrTranscript;
    void attach(transcriptPath, agentKind)
      .then((outcome) => {
        if (outcome !== "empty") return;
        this.skipTranscript(
          key,
          transcriptPath,
          signature,
          "CLI session has no conversation turns yet",
        );
      })
      .catch((error) => {
        if (isDeterministicAttachFailure(error)) {
          this.skipTranscript(key, transcriptPath, signature, String(error));
          return;
        }
        // 可重试失败（读不到 / 被截断 / 锁）保持原行为：放开 key，下一轮再试。
        this.attachedTranscriptKeys.delete(key);
        console.error("[trellis] failed to attach Herdr transcript", transcriptPath, error);
      });
  };

  /**
   * Herdr 报 blocked 的 claude 窗格 → 其当前会话 jsonl 里未完成的 tool_use（paneId → 待答）。
   * 窗格在跑（working / idle）时一律不算待答：未完成的 tool_use 只是工具还在执行。
   */
  transcriptPromptsByPane(
    bindings?: ReturnType<typeof listHerdrBindings>,
  ): Map<string, TranscriptPrompt> {
    const result = new Map<string, TranscriptPrompt>();
    const blocked = this.client.state.panes.filter(
      (pane) => pane.agent === "claude" && pane.agent_status === "blocked",
    );
    if (blocked.length === 0) return result;
    const all = bindings ?? listHerdrBindings(this.options.db);
    for (const pane of blocked) {
      const current = pane.agent_session?.value;
      // 绑定表按 alive / last_seen 倒序：herdr 没报当前会话时取这个窗格最近的一条
      const binding = current
        ? all.find((b) => b.paneId === pane.pane_id && b.sessionId === current)
        : all.find((b) => b.paneId === pane.pane_id);
      if (!binding?.transcriptPath || binding.agentKind !== "claude") continue;
      const prompt = this.transcriptPrompts.get(binding.transcriptPath);
      if (prompt) result.set(pane.pane_id, prompt);
    }
    return result;
  }

  /** claude 窗格 → 当前模型（读不到的窗格不出现在结果里）。 */
  transcriptModelsByPane(
    bindings: ReturnType<typeof listHerdrBindings>,
  ): Map<string, string> {
    const result = new Map<string, string>();
    for (const pane of this.client.state.panes) {
      if (pane.agent !== "claude") continue;
      const current = pane.agent_session?.value;
      const binding = current
        ? bindings.find((b) => b.paneId === pane.pane_id && b.sessionId === current)
        : bindings.find((b) => b.paneId === pane.pane_id);
      if (!binding?.transcriptPath || binding.agentKind !== "claude") continue;
      const model = this.transcriptModels.get(binding.transcriptPath);
      if (model) result.set(pane.pane_id, model);
    }
    return result;
  }

  /** 发键前的核对：窗格此刻的 herdr 状态 + transcript 待答（现读，不走 fleet 的 ETag）。 */
  paneTranscriptPrompt(paneId: string): { status: string | null; prompt: TranscriptPrompt | null } {
    const pane = this.client.state.panes.find((candidate) => candidate.pane_id === paneId);
    return {
      status: pane?.agent_status ?? null,
      prompt: this.transcriptPromptsByPane().get(paneId) ?? null,
    };
  }

  ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.client.start().catch((error) => {
        console.error("[trellis] Herdr startup failed", error);
      });
    }
    return this.startPromise;
  }

  stop(): void {
    this.stopped = true;
    this.listeners.clear();
    this.branchCache.clear();
    this.skippedTranscripts.clear();
    this.detach();
    this.client.stop();
  }

  fleet(): {
    available: boolean;
    enabled: boolean;
    realtime: boolean;
    readOnly: boolean;
    protocol: number | null;
    version: string | null;
    lastError: string | null;
    workspaces: Record<string, unknown>[];
    sessions: ReturnType<typeof listHerdrBindings>;
    inputDeliveries: HerdrInputDelivery[];
  } {
    const state = this.client.state;
    const sessions = listHerdrBindings(this.options.db);
    for (const binding of sessions) {
      if (binding.transcriptPath) {
        try {
          const stat = statSync(binding.transcriptPath);
          if (stat && stat.mtimeMs > (binding.lastSeenAt || 0)) {
            binding.lastSeenAt = Math.round(stat.mtimeMs);
          }
        } catch {
          // ignore transient filesystem misses
        }
      }
    }
    const prompts = this.transcriptPromptsByPane(sessions);
    const models = this.transcriptModelsByPane(sessions);
    const workspaces = state.workspaces.map((workspace) => ({
      ...workspace,
      worktree: this.worktrees.get(workspace.workspace_id) ?? null,
      tabs: state.tabs
        .filter((tab) => tab.workspace_id === workspace.workspace_id)
        .map((tab) => ({
          ...tab,
          panes: state.panes
            .filter((pane) => pane.tab_id === tab.tab_id)
            .map((pane) => ({
              pane_id: pane.pane_id,
              terminal_id: pane.terminal_id,
              focused: pane.focused,
              agent: pane.agent ?? null,
              agent_status: pane.agent_status,
              agent_session: pane.agent_session ?? null,
              cwd: pane.cwd ?? null,
              label: pane.label ?? null,
              terminal_title: pane.terminal_title ?? null,
              revision: pane.revision,
              transcript_prompt: prompts.get(pane.pane_id) ?? null,
              model: models.get(pane.pane_id) ?? null,
            })),
          layout: state.layouts.find((layout) => layout.tab_id === tab.tab_id) ?? null,
        })),
    }));
    return {
      available: state.available,
      enabled: state.enabled,
      realtime: state.realtime,
      readOnly: state.readOnly,
      protocol: state.protocol,
      version: state.version,
      lastError: state.lastError,
      workspaces,
      sessions,
      inputDeliveries: this.client.inputDeliveries,
    };
  }

  etag(): string {
    // transcript 待答不走 herdr 事件：jsonl 写完 tool_use 可能晚于窗格转 blocked，把它并进指纹
    const prompts = [...this.transcriptPromptsByPane()]
      .map(([paneId, prompt]) => `${paneId}=${prompt.toolUseId}`)
      .join(",");
    return `W/"herdr-${this.client.state.generation}-${this.bindingVersion}${prompts ? `-${prompts}` : ""}"`;
  }

  /** 排队送达（发前读屏核对见 HerdrClient.guardSend）；clearDraft 是用户同意清掉的电脑端单行草稿。 */
  input(paneId: string, text: string, clearDraft?: string, clientMsgId?: string): Promise<HerdrInputDelivery> {
    if (!clientMsgId) return this.client.enqueueInput(paneId, text, undefined, clearDraft);
    const key = `${paneId}\n${clientMsgId}`;
    const first = this.inputSends.peek(key);
    // 重复请求：回第一次的回执，换成它此刻的状态（第一次回的 queued 可能已经 delivered）。
    // 排队后送达前被读屏拒发（什么都没打）或被撤回的，忘掉旧记录、这次真的重新排队。
    if (first) {
      return first.then((receipt) => {
        const latest = this.client.inputDeliveries.find((d) => d.inputId === receipt.inputId) ?? receipt;
        if ((latest.status === "failed" && latest.refusal) || latest.status === "cancelled") {
          this.inputSends.delete(key);
          return this.input(paneId, text, clearDraft, clientMsgId);
        }
        return latest;
      });
    }
    return this.inputSends.run(key, () => this.client.enqueueInput(paneId, text, undefined, clearDraft), herdrInputNothingSent);
  }

  /** 撤回排队中的输入，见 HerdrClient.cancelInput。 */
  cancelInput(paneId: string, inputId: string): boolean {
    return this.client.cancelInput(paneId, inputId);
  }

  /** 立即打字（不排队），见 HerdrClient.sendText。 */
  text(paneId: string, text: string, submit = true, expectedRev?: string): Promise<Record<string, unknown>> {
    return this.client.sendText(paneId, text, submit, expectedRev);
  }

  /** 读屏认出此刻的对话框 + rev（pending 接口），见 HerdrClient.readPrompt。 */
  readPrompt(paneId: string): Promise<{ prompt: HerdrScreenPrompt | null; rev: string }> {
    return this.client.readPrompt(paneId);
  }

  /** 向任意窗格（包含纯 shell）发送命令或按键（终端抽屉使用）。 */
  command(
    paneId: string,
    command: string,
    keys: string[] = ["Enter"],
  ): Promise<Record<string, unknown>> {
    return this.client.executeCommand(paneId, command, keys);
  }

  /** expectedRev：卡片的 rev，发键前重读屏幕核对，对不上抛 HerdrPromptChangedError。 */
  keys(paneId: string, keys: string[], expectedRev?: string): Promise<Record<string, unknown>> {
    return this.client.sendKeys(paneId, keys, expectedRev);
  }

  /** 在 Herdr 终端里把焦点切到该窗格（次要操作；只读降级时 request 会拒绝写方法）。 */
  focus(paneId: string): Promise<Record<string, unknown>> {
    return this.client.request("pane.focus", { pane_id: paneId });
  }

  /** 创建一个新 Tab（可指定工作区、工作目录与标签名，默认聚焦该 Tab）。 */
  async createTab(params: { workspaceId?: string; cwd?: string; label?: string } = {}): Promise<{
    tabId: string;
    paneId: string;
    workspaceId: string;
    label: string;
  }> {
    const payload: Record<string, unknown> = { focus: true };
    if (params.workspaceId) payload.workspace_id = params.workspaceId;
    if (params.cwd) payload.cwd = params.cwd;
    if (params.label) payload.label = params.label;
    const res = await this.client.request<{
      tab: { tab_id: string; workspace_id: string; label: string };
      root_pane?: { pane_id: string; tab_id: string; workspace_id: string };
    }>("tab.create", payload);
    return {
      tabId: res.tab.tab_id,
      paneId: res.root_pane?.pane_id ?? "",
      workspaceId: res.tab.workspace_id,
      label: res.tab.label,
    };
  }

  read(
    paneId: string,
    lines = 200,
    format: "text" | "ansi" = "text",
  ): Promise<{ type: "pane_read"; read: { text: string } }> {
    return this.client.request("pane.read", {
      pane_id: paneId,
      source: "recent",
      lines,
      format,
    });
  }

  async reopen(sessionId: string): Promise<string> {
    const binding = getHerdrBinding(sessionId, this.options.db);
    if (!binding) throw new Error("Herdr session not found");
    const state = this.client.state;
    const candidates = state.panes.filter((pane) => pane.workspace_id === binding.workspaceId);
    const target =
      candidates.find((pane) => pane.agent == null) ??
      candidates.find((pane) => pane.agent_status === "idle" || pane.agent_status === "done");
    if (!target) throw new Error("Original Herdr workspace has no idle pane; open one in Herdr first");
    return this.client.splitAndResume(
      target as HerdrPane,
      binding.sessionId,
      binding.agentKind,
      binding.cwd ?? target.cwd ?? null,
    );
  }
}

/**
 * 这次输入失败时确定什么都没打（读屏拒发 / Herdr 不可用 / 排队满 / 窗格不对）：忘掉 client_msg_id，
 * 让带同一个 id 的重发真的再试。按 name / code 认 —— 错误可能来自另一个路由 bundle 里的类。
 */
function herdrInputNothingSent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "HerdrSendRefusedError" || error.name === "HerdrUnavailableError") return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ["queue_full", "pane_not_found", "not_agent_pane", "pane_changed", "input_cancelled"].includes(code);
}

const globalFleet = globalThis as typeof globalThis & {
  __trellisHerdrFleet?: HerdrFleetService;
};

export function getHerdrFleetService(): HerdrFleetService {
  if (!globalFleet.__trellisHerdrFleet) {
    globalFleet.__trellisHerdrFleet = new HerdrFleetService();
  }
  return globalFleet.__trellisHerdrFleet;
}
