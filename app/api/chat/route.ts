import {
  isProviderId,
  DEFAULT_PROVIDER,
  providerFamily,
  type ProviderId,
  type Mode,
} from "@/lib/llm";
import { getProvider } from "@/lib/llm/server";
import { getAgentBySlug, resolveEnabledAgent } from "@/lib/server/agents";
import { resolveAgentSpawn } from "@/lib/server/agent-pack";
import { generateTopicLabel } from "@/lib/llm/topic";
import {
  createSessionWithRoot,
  createRootInSession,
  createBranchNode,
  buildHistoryForNode,
  resetNodeForRetry,
  getNode,
  getNodeAttachments,
  getSession,
  getRootResumeIdForNode,
  getParentResumeId,
  isLineageIsolated,
  setNodeResumeId,
  setNodeAgent,
} from "@/lib/server/repo";
import {
  attachedLineageForNode,
  buildPrefixJsonl,
  buildPrefixJsonlCore,
  hasOtherChild,
  nativeLineageForNode,
  registerForkLineage,
} from "@/lib/server/cli-fork";
import {
  buildCodexPrefixRollout,
  codexLineageForNode,
} from "@/lib/server/codex-fork";
import { startRun, subscribe } from "@/lib/server/run-bus";
import {
  resolveBlobPath,
  isValidHash,
  materializeAttachments,
  readTextBlob,
} from "@/lib/server/blobs";
import { isKnownAttachmentMime, isTextMime } from "@/lib/attachments";
import { sessionCwd } from "@/lib/paths";
import type { NodeAttachment } from "@/lib/types";

const VALID_MODES: Mode[] = ["chat", "project"];
function isMode(s: unknown): s is Mode {
  return typeof s === "string" && (VALID_MODES as string[]).includes(s);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRequestRoot = {
  kind: "root";
  question: string;
  // When present, attach a parallel root (parent_id=NULL) to the existing
  // session instead of creating a new session. Used by the canvas "新提问"
  // entry — same investigation, fresh lineage. mode + workspacePath are
  // ignored in this branch (locked from the existing session).
  sessionId?: string;
  provider?: ProviderId;
  // mode + workspacePath only matter when creating a new session (no
  // sessionId). After creation they're locked in the DB row.
  mode?: Mode;
  workspacePath?: string | null;
  // D1: chat-mode custom system prompt for a new session. Locked at
  // creation; ignored for project (it uses CLAUDE.md).
  systemPrompt?: string | null;
  // 权限确认（new session 时锁定）：true = project 的可变更工具逐个弹权限卡。
  // 仅 claude 系 + project 模式生效，其余组合服务端钳成 false。
  requireApproval?: boolean;
  // S88 会话人设（new session 时锁定）：agents.id。仅 claude 系生效，其余钳成 null。
  // 与 systemPrompt 互斥 —— 选了 agent 就以 agent 的人设为准。
  agentId?: string | null;
  // Stage 15: image attachments uploaded via /api/uploads. The client
  // sends NodeAttachment shapes; the server hash-resolves to on-disk
  // paths before handing to the provider.
  attachments?: NodeAttachment[];
};

type ChatRequestBranch = {
  kind: "branch";
  parentNodeId: string;
  question: string;
  parentAnchor?: { selectedText: string } | null;
  provider?: ProviderId;
  attachments?: NodeAttachment[];
  // S88 @提及：把**这一轮**定向派给某个 agent（slug），主线人格不变。
  // 只在 branch 上有意义 —— 「换个人答这一轮」天然是分支语义。
  mentionAgentSlug?: string | null;
};

type ChatRequestRetry = {
  kind: "retry";
  nodeId: string;
  provider?: ProviderId;
  // Retry intentionally has no attachments — the server re-reads the
  // node's stored attachments_json so the user doesn't have to re-pick.
};

type ChatRequest = ChatRequestRoot | ChatRequestBranch | ChatRequestRetry;

function nid(): string {
  return crypto.randomUUID();
}

// History depth knob. 0 = B-fork (append-only via --fork-session, chat+claude
// default — history lives in the forked CLI session, nothing folded into the
// prompt). 1-12 = window mode (fold N ancestor turns — the fallback, also used
// by codex chat). Anything out of [0,12] or missing → 0.
function clampDepth(n: unknown): number {
  return typeof n === "number" && n >= 0 && n <= 12 ? Math.round(n) : 0;
}

// Defensive cleanup of client-supplied attachments. Drops anything with a
// malformed hash / bad mime; preserves order and metadata of valid items.
// Hard cap of 6 — matches spec's per-node limit; further trimming the
// client missed is harmless rather than a hard fail.
function sanitizeAttachments(raw: unknown): NodeAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.hash !== "string" || !isValidHash(a.hash)) continue;
    if (typeof a.mime !== "string" || !isKnownAttachmentMime(a.mime)) continue;
    if (typeof a.size !== "number") continue;
    out.push({
      hash: a.hash,
      mime: a.mime,
      size: a.size,
      filename: typeof a.filename === "string" ? a.filename : null,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
    });
    if (out.length >= 6) break;
  }
  return out;
}

// Resolve NodeAttachment[] (hash refs) to provider-ready {path, mime}.
// Drops items whose blob is missing on disk (rare but possible if the
// blobs dir got wiped between upload and submit).
function resolveAttachments(
  attachments: NodeAttachment[],
): { path: string; mime: string }[] {
  const resolved: { path: string; mime: string }[] = [];
  for (const a of attachments) {
    const r = resolveBlobPath(a.hash);
    if (r) resolved.push(r);
  }
  return resolved;
}

// Pure-chat inline cap for text attachments. ~32k tokens worst case —
// big enough for real CSV/log samples, small enough to not blow the
// context window on a single file.
const INLINE_CAP_BYTES = 128 * 1024;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Generic (non-image) attachments reach the model as prompt text, shaped
// by what the mode can do:
//  - tool-capable (project / enhanced chat): stage blobs to
//    ~/.trellis/uploads/<nodeId>/ under their original filenames and list
//    absolute paths — the agent reads/parses them with its own tools.
//  - pure chat (web tools only): inline text files bodily (≤ cap); note
//    anything unreadable so the model doesn't hallucinate the content.
// Staging is idempotent per nodeId, so retry (which re-reads attachments
// from the DB) rebuilds the exact same paths.
function buildFileAttachmentSuffix(
  nodeId: string,
  files: NodeAttachment[],
  toolCapable: boolean,
): string {
  if (files.length === 0) return "";
  if (toolCapable) {
    const staged = materializeAttachments(nodeId, files);
    if (staged.length === 0) return "";
    const lines = staged.map(
      (s) => `- ${s.path}（${s.mime}, ${fmtSize(s.size)}）`,
    );
    return `\n\n[用户上传的附件文件，已保存在本地磁盘，可直接用 Read / Bash 等工具读取：]\n${lines.join("\n")}`;
  }
  const parts: string[] = [];
  for (const f of files) {
    const name = f.filename ?? `file-${f.hash.slice(0, 8)}`;
    const text = isTextMime(f.mime)
      ? readTextBlob(f.hash, INLINE_CAP_BYTES)
      : null;
    if (text !== null) {
      // Four-backtick fence so embedded ``` in the file body can't
      // break out of the block.
      parts.push(
        `文件「${name}」（${f.mime}）的完整内容：\n\`\`\`\`\n${text}\n\`\`\`\``,
      );
    } else {
      const reason = isTextMime(f.mime)
        ? "超过内联大小上限"
        : "二进制文件需要文件工具";
      parts.push(
        `文件「${name}」（${f.mime}, ${fmtSize(f.size)}）已上传，但纯对话模式无法读取（${reason}）——请提醒用户改用增强模式 / Project 再问。`,
      );
    }
  }
  return `\n\n[用户上传的附件]\n${parts.join("\n\n")}`;
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.kind !== "retry" && !body.question?.trim()) {
    return Response.json({ error: "empty question" }, { status: 400 });
  }

  const providerId = isProviderId(body.provider)
    ? body.provider
    : DEFAULT_PROVIDER;
  const now = Date.now();

  // Create the row(s) up front so the client gets ids in the first SSE event,
  // and the data is durable if the request aborts.
  let nodeId: string;
  let trellisSessionId: string;
  let createdEvent: Record<string, unknown>;
  let parentAnchor: { selectedText: string } | null = null;
  let questionForLLM: string;
  // Resolved at session create (new root) or read from DB (everything else).
  let resolvedMode: Mode;
  let resolvedWorkspacePath: string | null;
  // D1: chat-mode system prompt, resolved the same way (new = from body,
  // everything else = from the locked session row). null = provider default.
  let resolvedSystemPrompt: string | null = null;
  // CLI 同步：'native' | 'cli-import'。attached（cli-import）会话的续聊/分叉走
  // lineage 解析（P2），其余 mode 走原生 resume。read from DB（branch 取 parentSession）。
  let resolvedOrigin = "native";
  // 权限确认：new root 从 body 钳制后锁进 session 行；其余路径从 session 行读。
  let resolvedRequireApproval = false;
  // S88 会话人设。与 requireApproval 完全同构：new root 从 body 钳制后锁进 session
  // 行，并行 root / branch / retry 一律从 session 行读回。null = 默认 Agent。
  let resolvedAgentId: string | null = null;
  // S88 @提及：单轮定向。与会话人设是两套 —— 它不写 sessions 行，只作用于本轮，
  // 且**不 resume 主线**（外援的人设写进主线 CLI session 会污染人格），
  // 也**不 fork**（会在 jsonl 目录留孤儿 session 让 nativeLineageForNode 认错 tip）。
  const mentionAgent =
    body.kind === "branch" &&
    typeof body.mentionAgentSlug === "string" &&
    providerFamily(providerId) !== "mock"
      ? getAgentBySlug(body.mentionAgentSlug)
      : null;
  const mentionActive = !!(mentionAgent && mentionAgent.enabled);
  // Image attachments — supplied by client for root/branch, read from
  // DB for retry. Always normalized to NodeAttachment[] before going
  // into createNode args (so they land in attachments_json) and
  // resolved to file paths for the provider call.
  let resolvedAttachments: NodeAttachment[] = [];

  try {
    if (body.kind === "root") {
      resolvedAttachments = sanitizeAttachments(body.attachments);
      if (body.sessionId) {
        // Parallel root inside an existing session — mode/workspace stay
        // locked from the existing session row, ignore any body fields.
        trellisSessionId = body.sessionId;
        const existing = getSession(trellisSessionId);
        if (!existing) {
          return Response.json({ error: "session not found" }, { status: 404 });
        }
        resolvedMode = isMode(existing.mode) ? existing.mode : "chat";
        resolvedWorkspacePath = existing.workspacePath;
        resolvedSystemPrompt = existing.systemPrompt;
        resolvedRequireApproval = existing.requireApproval;
        resolvedAgentId = existing.agentId;
        nodeId = nid();
        const node = createRootInSession({
          sessionId: trellisSessionId,
          nodeId,
          question: body.question,
          now,
          attachments: resolvedAttachments,
        });
        createdEvent = { type: "created", node };
      } else {
        // New session — body picks the mode + workspace, then locks them.
        resolvedMode = isMode(body.mode) ? body.mode : "chat";
        const wp =
          typeof body.workspacePath === "string" && body.workspacePath.trim()
            ? body.workspacePath
            : null;
        // D1: only chat mode carries a custom system prompt; clamp it away
        // for project (its persona comes from CLAUDE.md).
        if (resolvedMode === "chat") {
          const sp =
            typeof body.systemPrompt === "string" && body.systemPrompt.trim()
              ? body.systemPrompt.trim()
              : null;
          resolvedSystemPrompt = sp;
        } else {
          resolvedSystemPrompt = null;
        }
        if (resolvedMode === "chat") {
          // chat has no cwd binding; clamp any client-side workspace_path away.
          resolvedWorkspacePath = null;
        } else {
          // project requires a path.
          if (!wp) {
            return Response.json(
              { error: `${resolvedMode} mode requires workspacePath` },
              { status: 400 },
            );
          }
          resolvedWorkspacePath = wp;
        }
        // 权限确认钳制：只有 claude 系的 project 才可开（chat 无文件工具；
        // codex/mock 无 stdio 协议，开了也是谎言级 UI）。
        resolvedRequireApproval =
          body.requireApproval === true &&
          resolvedMode !== "chat" &&
          providerFamily(providerId) === "claude";
        // Both real providers support the product-level Agent abstraction.
        // Claude uses --agent/plugin packs; Codex receives an equivalent
        // persona + selected skill instructions through its system prompt.
        resolvedAgentId =
          typeof body.agentId === "string" &&
          providerFamily(providerId) !== "mock" &&
          resolveEnabledAgent(body.agentId)
            ? body.agentId
            : null;
        trellisSessionId = nid();
        nodeId = nid();
        const { session, node } = createSessionWithRoot({
          sessionId: trellisSessionId,
          nodeId,
          title: body.question.slice(0, 60),
          question: body.question,
          now,
          mode: resolvedMode,
          workspacePath: resolvedWorkspacePath,
          systemPrompt: resolvedSystemPrompt,
          model: providerId,
          requireApproval: resolvedRequireApproval,
          agentId: resolvedAgentId,
          attachments: resolvedAttachments,
        });
        createdEvent = { type: "created", session, node };
      }
      questionForLLM = body.question;
    } else if (body.kind === "branch") {
      if (!body.parentNodeId) {
        return Response.json(
          { error: "missing parentNodeId" },
          { status: 400 },
        );
      }
      nodeId = nid();
      parentAnchor = body.parentAnchor ?? null;
      resolvedAttachments = sanitizeAttachments(body.attachments);
      const node = createBranchNode({
        nodeId,
        parentId: body.parentNodeId,
        question: body.question,
        parentAnchor,
        now,
        attachments: resolvedAttachments,
      });
      trellisSessionId = node.sessionId;
      const parentSession = getSession(trellisSessionId);
      resolvedMode =
        parentSession && isMode(parentSession.mode) ? parentSession.mode : "chat";
      resolvedWorkspacePath = parentSession?.workspacePath ?? null;
      resolvedSystemPrompt = parentSession?.systemPrompt ?? null;
      resolvedOrigin = parentSession?.origin ?? "native";
      resolvedRequireApproval = parentSession?.requireApproval ?? false;
      resolvedAgentId = parentSession?.agentId ?? null;
      createdEvent = { type: "created", node };
      questionForLLM = body.question;
    } else if (body.kind === "retry") {
      if (!body.nodeId) {
        return Response.json({ error: "missing nodeId" }, { status: 400 });
      }
      const reset = resetNodeForRetry(body.nodeId);
      if (!reset) {
        return Response.json({ error: "node not found" }, { status: 404 });
      }
      nodeId = body.nodeId;
      questionForLLM = reset.question;
      parentAnchor = reset.parentAnchor;
      // Retry re-uses the original node's attachments — the user
      // shouldn't have to re-attach the images they already submitted.
      resolvedAttachments = getNodeAttachments(nodeId);
      const node = getNode(nodeId);
      if (!node) {
        return Response.json({ error: "node disappeared" }, { status: 500 });
      }
      trellisSessionId = node.sessionId;
      const retrySession = getSession(trellisSessionId);
      resolvedMode =
        retrySession && isMode(retrySession.mode) ? retrySession.mode : "chat";
      resolvedWorkspacePath = retrySession?.workspacePath ?? null;
      resolvedSystemPrompt = retrySession?.systemPrompt ?? null;
      resolvedRequireApproval = retrySession?.requireApproval ?? false;
      resolvedAgentId = retrySession?.agentId ?? null;
      createdEvent = { type: "created", node };
    } else {
      return Response.json({ error: "unknown kind" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }

  const mode = resolvedMode;
  // Resume ids are provider-family-scoped: read/write the family-correct
  // column so a codex session can't be handed to `claude --resume`.
  const family = providerFamily(providerId);
  const llm = getProvider(providerId, { mode });
  // Split attachments: images ride the provider's native vision path
  // (claude base64 stream-json / codex --image); generic files never
  // enter it — they reach the model as prompt text (path injection or
  // inline, see buildFileAttachmentSuffix below once mode is resolved).
  const imageAttachments = resolvedAttachments.filter((a) =>
    a.mime.startsWith("image/"),
  );
  const fileAttachments = resolvedAttachments.filter(
    (a) => !a.mime.startsWith("image/"),
  );
  // Resolve image hashes → on-disk paths once, here. The provider
  // doesn't talk to the blobs module so it can stay free of fs lookups.
  const providerAttachments = resolveAttachments(imageAttachments);

  // chat B-fork (claude only, depth 0 = default): history lives in the forked
  // CLI session — fold nothing, resume the PARENT node's session. depth>=1 or
  // codex falls back to window mode (folded history). project folds nothing
  // either (history in the resumed root session).
  const reqDepth = clampDepth((body as { historyDepth?: number }).historyDepth);
  const chatEnhanced =
    (body as { chatEnhanced?: boolean }).chatEnhanced === true;
  // Generic file attachments → prompt text. Keep the pre-suffix question
  // for topic labeling so an inlined 100KB CSV doesn't pollute the label
  // prompt. Injected only into THIS turn (matches images: not re-sent in
  // folded history; project/B-fork resume keeps it in the CLI session).
  const questionForTopic = questionForLLM;
  questionForLLM += buildFileAttachmentSuffix(
    nodeId,
    fileAttachments,
    mode !== "chat" || chatEnhanced,
  );
  let chatBFork = mode === "chat" && family === "claude" && reqDepth === 0;
  // codex chat（B-fork 等价，depth 0）：codex 无 --fork-session，但 `codex exec
  // resume` 线性续聊 + 前缀 rollout 分叉可以拼出同一语义（分支互相隔离、历史住
  // 在 CLI session 里不折叠）。handled=false = 父节点没有可解析的 rollout
  // （存量会话 / rollout 被清）→ 回落折叠窗口，行为同旧。
  let codexChatHandled = false;
  let codexChatSid: string | null = null;
  if (mode === "chat" && family === "codex" && reqDepth === 0) {
    const chatParentId =
      body.kind === "branch"
        ? body.parentNodeId
        : body.kind === "retry"
          ? (getNode(nodeId)?.parentId ?? null)
          : null;
    if (!chatParentId) {
      // root 首轮（或 root 重试）：fresh + persistence，sid 由 session_init 落本节点
      codexChatHandled = true;
    } else {
      const lin = codexLineageForNode(chatParentId);
      if (lin) {
        codexChatHandled = true;
        if (lin.isRolloutTip && !hasOtherChild(chatParentId, nodeId)) {
          codexChatSid = lin.lineageSid; // 线性续：resume 同 rollout（sid 不变）
        } else if (lin.nodeTurnOrdinal) {
          // 真分叉（含 retry——旧回答已 append 进共享 rollout，必须切掉）
          const built = buildCodexPrefixRollout(lin.rolloutPath, lin.nodeTurnOrdinal);
          if (built) {
            setNodeResumeId(nodeId, family, built.newSid);
            codexChatSid = built.newSid;
          } else {
            codexChatSid = lin.lineageSid; // 构造失败：降级线性（上下文只多不错）
          }
        } else {
          codexChatSid = lin.lineageSid; // ordinal 回填缺失：降级线性
        }
      }
    }
  }
  // codex chat at depth>=1 / unresolvable — fold history at a sane default depth.
  const foldDepth = reqDepth === 0 ? 4 : reqDepth;
  let history =
    chatBFork || codexChatHandled || mode === "project"
      ? []
      : buildHistoryForNode(nodeId, { maxDepth: foldDepth });
  // Resume id (StreamRequest.claudeSessionId — legacy name, value is the active
  // family's resume id). project shares the ROOT's id across the whole tree
  // (getRoot…, each root owns a per-family id since the post-2026-05 upgrade).
  // chat B-fork resumes the IMMEDIATE PARENT's forked session (getParent…) so
  // each branch continues its own lineage in isolation — null on a B-fork first
  // turn (root has no parent) → fresh session, no --fork-session. For claude we
  // validate the transcript jsonl still exists (passing resolvedWorkspacePath),
  // self-healing stale/cleaned/family-polluted ids by falling back to fresh
  // instead of failing `claude --resume`.
  // claude spawns in this cwd → its session jsonl lands here, so resume
  // validation, the provider spawn, and cleanup must ALL use the same value.
  // sessionCwd centralizes the chat→scratch / project→bound-path mapping.
  const spawnCwd = sessionCwd(mode, resolvedWorkspacePath);
  // attached CLI 会话（origin='cli-import'）的续聊/分叉走 lineage 解析（P2，
  // progress/cli-branch-alignment-p2-spec.md）：从某 lineage 的 jsonl tip 且 X 在
  // trellis 无其他子 → 线性 resume 该 lineage（append 同 jsonl）；否则（非 tip 或已有
  // 子）→ buildPrefixJsonl 在 X 构造前缀 jsonl、resume 新 sid 成新 fork lineage。
  // Claude 以 turn uuid 切前缀；Codex 以 rollout 内 user-turn ordinal 切前缀。
  let attachedHandled = false;
  let claudeSessionId: string | null = null;
  if (
    resolvedOrigin === "cli-import" &&
    body.kind === "branch" &&
    family === "claude"
  ) {
    const branchFrom = body.parentNodeId;
    const lin = attachedLineageForNode(branchFrom);
    if (lin) {
      attachedHandled = true;
      if (lin.isJsonlTip && !hasOtherChild(branchFrom, nodeId)) {
        claudeSessionId = lin.lineageSid; // 线性续：--resume 同 lineage，append 同 jsonl
      } else {
        const built = buildPrefixJsonl(branchFrom); // 任意点分叉
        if (built) {
          registerForkLineage(
            trellisSessionId,
            built.newSid,
            built.jsonlPath,
            branchFrom, // fork_point = X turn uuid
          );
          // 新节点归属新 fork lineage（reconcile 删临时节点后 canonical 会重得同值）。
          setNodeResumeId(nodeId, family, built.newSid);
          claudeSessionId = built.newSid;
        } else {
          claudeSessionId = lin.lineageSid; // 构造失败兜底线性
        }
      }
    }
  }
  if (
    resolvedOrigin === "cli-import" &&
    body.kind === "branch" &&
    family === "codex"
  ) {
    const branchFrom = body.parentNodeId;
    const lin = codexLineageForNode(branchFrom);
    if (lin) {
      attachedHandled = true;
      if (lin.isRolloutTip && !hasOtherChild(branchFrom, nodeId)) {
        claudeSessionId = lin.lineageSid;
      } else if (lin.nodeTurnOrdinal) {
        const built = buildCodexPrefixRollout(lin.rolloutPath, lin.nodeTurnOrdinal);
        if (built) {
          registerForkLineage(
            trellisSessionId,
            built.newSid,
            built.rolloutPath,
            branchFrom,
            "codex",
          );
          setNodeResumeId(nodeId, family, built.newSid);
          claudeSessionId = built.newSid;
        } else {
          claudeSessionId = lin.lineageSid;
        }
      } else {
        claudeSessionId = lin.lineageSid;
      }
    }
  }
  // 原生 per-lineage 隔离（progress/project-lineage-isolation-spec.md）：新建的
  // project session（lineage_isolation=1）走 lineage 解析，路由与 attached P2 同构：
  // 父是 lineage jsonl tip 且无其他子 → 线性 resume 该 lineage（append 同 jsonl）；
  // 真分叉 → 前缀 jsonl 在父 turn 分叉成新 lineage；uuid 缺失/构造失败 → 降级线性
  // （= 旧共享行为，上下文只多不错）。root/新话题 → fresh，sid 由 session_init 落
  // 本节点（lineage 头自持）。仅 claude family；存量 session（flag=0）与 codex 走
  // 下方旧路径。
  let nativeIsolated = false;
  if (
    !attachedHandled &&
    mode === "project" &&
    family === "claude" &&
    resolvedOrigin === "native" &&
    isLineageIsolated(trellisSessionId)
  ) {
    nativeIsolated = true;
    if (body.kind === "branch") {
      const lin = nativeLineageForNode(body.parentNodeId, spawnCwd);
      if (!lin) {
        // 祖先链无可用 lineage（首轮失败 / jsonl 被清）→ fresh，本节点成新 lineage 头。
        claudeSessionId = null;
      } else if (lin.isJsonlTip && !hasOtherChild(body.parentNodeId, nodeId)) {
        claudeSessionId = lin.lineageSid;
      } else if (lin.nodeTurnUuid) {
        const built = buildPrefixJsonlCore(lin.jsonlPath, lin.nodeTurnUuid);
        if (built) {
          // 新 lineage 头预写 sid（trellis 同步生成，不依赖 session_init）。
          setNodeResumeId(nodeId, family, built.newSid);
          claudeSessionId = built.newSid;
        } else {
          claudeSessionId = lin.lineageSid;
        }
      } else {
        claudeSessionId = lin.lineageSid;
      }
    } else if (body.kind === "retry") {
      // self-or-ancestor：fork 头重试续自己的 lineage，线性节点续父 lineage；
      // jsonl 缺失 → null → fresh + sid 落本节点（自愈，同 claudeJsonlExists 纪律）。
      const lin = nativeLineageForNode(nodeId, spawnCwd);
      claudeSessionId = lin?.lineageSid ?? null;
    } else {
      claudeSessionId = null; // root / 新话题：fresh lineage
    }
  }
  // codex 版 per-lineage 隔离：与上面 claude 块同构，engine 换 codex-fork
  // （rollout 无 uuid 链，下刀坐标 = user-message 序号）。存量 codex project
  // （iso=0）不迁移，走下方旧路径（全树共享 root rollout）。retry 与 claude 同
  // 纪律：线性 resume 自己/祖先的 lineage（旧回答留在 rollout，上下文只多不错）。
  if (
    !attachedHandled &&
    !nativeIsolated &&
    mode === "project" &&
    family === "codex" &&
    resolvedOrigin === "native" &&
    isLineageIsolated(trellisSessionId)
  ) {
    nativeIsolated = true;
    if (body.kind === "branch") {
      const lin = codexLineageForNode(body.parentNodeId);
      if (!lin) {
        claudeSessionId = null; // 祖先链无可用 lineage → fresh，本节点成新头
      } else if (lin.isRolloutTip && !hasOtherChild(body.parentNodeId, nodeId)) {
        claudeSessionId = lin.lineageSid;
      } else if (lin.nodeTurnOrdinal) {
        const built = buildCodexPrefixRollout(lin.rolloutPath, lin.nodeTurnOrdinal);
        if (built) {
          setNodeResumeId(nodeId, family, built.newSid);
          claudeSessionId = built.newSid;
        } else {
          claudeSessionId = lin.lineageSid;
        }
      } else {
        claudeSessionId = lin.lineageSid;
      }
    } else if (body.kind === "retry") {
      const lin = codexLineageForNode(nodeId);
      claudeSessionId = lin?.lineageSid ?? null;
    } else {
      claudeSessionId = null; // root / 新话题：fresh lineage
    }
  }
  if (!attachedHandled && !nativeIsolated) {
    claudeSessionId =
      mode === "project"
        ? getRootResumeIdForNode(nodeId, family, spawnCwd)
        : chatBFork
          ? getParentResumeId(nodeId, family, spawnCwd)
          : codexChatHandled
            ? codexChatSid
            : null;
  }

  // S88 @提及：外援是**一次性**的 —— 覆盖掉上面那整套身份解析。
  //   · 不 resume 主线：外援的人设写进主线 CLI session 会永久污染主线人格；
  //   · 不 fork：会在 cwd 的 jsonl 目录留一个孤儿 session，让 nativeLineageForNode
  //     的簿记认错 tip（这是 cli-fork 那套最脆的地方）；
  //   · 不落盘（ephemeral）：外援看一眼就走，不该在 resume 链上留痕。
  // 上下文靠折叠历史 —— 复用已有的降级路径，零新代码。
  if (mentionActive) {
    claudeSessionId = null;
    chatBFork = false;
    if (history.length === 0) {
      history = buildHistoryForNode(nodeId, { maxDepth: 4 });
    }
  }

  // Stage 17: spawn ownership now lives in run-bus, not this handler.
  // We start the run with its own AbortController; HTTP disconnect only
  // unsubscribes us from the event broadcast — the LLM keeps running and
  // keeps writing to the DB. Late tabs / a returning mobile client pick
  // up via GET /api/nodes/[id]/stream.
  // A路②: only the claude family speaks the stdio permission protocol that
  // backs interactive tools (AskUserQuestion / ExitPlanMode). codex/mock get
  // no callback, so run-bus passes ctx.onCanUseTool=undefined and the provider
  // never opens the protocol. Pure chat (no workspace) won't trigger the
  // interactive tools, but threading the callback is harmless there.
  const interactive = family === "claude";
  // S88: 把 agent 定义变成「CLI 能吃的东西」。放在 route 而不是 sdk-adapter：
  // 后者至今是纯函数无 IO，且被 codex 共用；route 本就是策略解析层
  // （mode / workspace / resume / approval 都在这儿定）。
  // agent 被停用 / 被删 → resolveEnabledAgent 返回 null → 静默退回默认人设，
  // 绝不让「人设没了」变成「会话发不出消息」。
  // @提及优先于会话人设：这一轮是外援答的。
  const agentRecord = mentionActive ? mentionAgent : resolveEnabledAgent(resolvedAgentId);
  const agentSpawn = agentRecord && family !== "mock"
    ? resolveAgentSpawn(agentRecord, family, resolvedWorkspacePath)
    : null;
  // 每轮落一份「谁答的」。会话级也记 —— agent 定义是 live 引用（改了老会话跟着变），
  // 这一列是事后唯一能追溯「当时哪个 agent 答的」的线索。
  if (agentRecord) {
    setNodeAgent(nodeId, agentRecord.id, mentionActive ? "mention" : "session");
  }
  startRun({
    nodeId,
    // chat B-fork writes the forked id to THIS node (per-node); native isolated
    // project writes the fresh lineage head's id to THIS node (fork heads were
    // pre-written above, so claudeSessionId is set → undefined); legacy project
    // writes the root-shared id on its first turn only; codex/mock/window
    // persist none.
    sessionIdTarget: attachedHandled
      ? undefined
      : nativeIsolated
        ? claudeSessionId
          ? undefined
          : "node"
        : chatBFork || codexChatHandled
          ? "node"
          : mode === "project"
            ? claudeSessionId
              ? undefined
              : "root"
            : undefined,
    resumeFamily: family,
    interactive,
    requireApproval: resolvedRequireApproval,
    factory: (signal, ctx) =>
      llm.stream({
        history,
        question: questionForLLM,
        parentAnchor,
        signal,
        claudeSessionId,
        cwd: spawnCwd,
        systemPrompt: resolvedSystemPrompt,
        agent: agentSpawn,
        // @提及：一次性 spawn，不落盘不 resume（见上方 mentionActive 那段）。
        ephemeral: mentionActive,
        chatEnhanced,
        // claude B-fork 与 codex chat resume 共用这面旗：sdk-adapter 据此开
        // persistence+resume（--fork-session 本身 codex backend 会忽略）。
        forkSession: chatBFork || codexChatHandled,
        requireApproval: resolvedRequireApproval,
        attachments: providerAttachments,
        onCanUseTool: ctx?.onCanUseTool,
      }),
    topicLabel:
      providerId !== "mock"
        ? (aggregated) => generateTopicLabel(questionForTopic, aggregated, family)
        : undefined,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The bus doesn't know about session/node entities — the first
      // event the client sees is still the `created` payload assembled
      // up here. After that, live RunEvents flow through.
      send(createdEvent);

      const unsubscribe = subscribe(nodeId, {
        onEvent: (event) => {
          // Suppress catchup for the freshly-started run — the client
          // already has the node row (empty response) from `created`,
          // and the catchup payload would always be "" for the first
          // subscriber anyway. Reconnect endpoints DO forward catchup;
          // see GET /api/nodes/[id]/stream.
          if (event.type === "catchup") return;
          send(event);
        },
        onClose: close,
      });
      if (!unsubscribe) {
        // Shouldn't happen — we just startRun'd. Defensive close.
        close();
        return;
      }

      // HTTP disconnect: drop our subscription, but let the run continue.
      // Explicit abort goes through POST /api/chat/[id]/abort, not the
      // request signal.
      const onAbort = () => {
        unsubscribe();
        close();
      };
      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
