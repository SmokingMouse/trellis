"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CornerDownRight, GitBranch, ListPlus, PenLine, Square } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { useComposerQueueStore, useSessionQueue } from "@/stores/composerQueueStore";
import {
  editQueued,
  enqueue,
  newQueuedMessage,
  observeQueue,
  queueStatus,
  removeQueued,
  requeueFailed,
  resumeQueue,
  type BusySendMode,
  type ComposerQueue,
  type QueueAction,
  type QueuedMessage,
  type QueueTarget,
} from "@/lib/composer-queue";
import type { ComposerQueueItem } from "./ComposerShell";
import { appendToDraft, useComposerInsertStore } from "@/stores/composerInsertStore";
import { sessionScopedKey } from "@/lib/prefs";
import { sendHint } from "@/lib/send-key";
import { matchCommands, parseCommand, type Command, type CommandStore } from "@/lib/commands";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { useAgentMentions, splitMention } from "@/hooks/useAgentMentions";
import { refFromItem, useNodeRefMentions, type RefPickItem } from "@/hooks/useNodeRefMentions";
import { appendNodeRefs, MAX_NODE_REFS, removeMentionQuery, type NodeRef } from "@/lib/node-refs";
import { NodeRefChips } from "./NodeRefChips";
import { providerFamily } from "@/lib/llm";
import { useSlashNav } from "@/hooks/useSlashNav";
import { useAttachmentUploads } from "@/hooks/useAttachmentUploads";
import { SkillPickerList } from "./SkillPickerList";
import { AttachmentPreview } from "./AttachmentPreview";
import { COMPOSER_TOOL_ICON, ComposerShell } from "./ComposerShell";
import { SketchModal } from "./SketchModal";
import { isOptimisticNodeId } from "@/stores/sessionStore";
import { Button, Icon, IconButton, Spinner, Tooltip } from "@/components/ui";
import { ModeBadge } from "./ModeBadge";
import { ModelPicker } from "./ModelPicker";
import { ComposerAttachButton, useAttachPicker } from "./ComposerAttachButton";
import { ComposerStatusBar } from "./ComposerStatusBar";
import { composerStatusPills, runningBackgroundTasks } from "@/lib/composer-status";
import { contextUsageFor } from "@/lib/context-usage";
import { contextWindowFor } from "@/lib/llm";
import type { ChatNode } from "@/lib/types";

// #3/#7: the shared always-docked composer. Used by the linear thread's
// sticky footer and the canvas's fixed bottom bar.
//
// W3：单一卡片式输入（描边卡 + 聚焦描边环）。卡内：可选横幅（分叉目标）→
// 附件 → 输入框 → 底栏（模式 chip · 模型 · 附件 / 手绘 ghost 图标 ·「发送到」·
// 主按钮）；卡外一行弱化提示（状态 + 快捷键）。主按钮三态合一：空闲 = 发送、
// 流式 = 停止、连接中 / 上传中 = 加载。流式时输入框不再被停止按钮替换。
// 回复进行中继续发送（参考 Codex 手机端 Queue vs Steer，lib/composer-queue.ts）：
//   - 排队：进入本会话的排队列表（卡片上方，可编辑 / 取消），本轮成功结束后
//     自动按序发出；出错 / 被停止则暂停，等「继续发送」。
//   - 插话：注入正在跑的这一轮（/api/nodes/[id]/as/steer），只有 Agent 服务上的
//     thread 会话支持；其它会话不显示这个入口，服务端拒绝时自动改为排队。
//   默认用哪个是偏好（busySendMode），另一个是展开态里主按钮旁的次级入口；没草稿时
//   主按钮原地变成停止，有草稿时停止退到主按钮左侧小槽（桌面仍在最右）。
// 草稿按会话存 localStorage：切会话 / 刷新都不丢；发送没落地（服务端没回
// `created`）时把原文放回输入框。

function readDraft(key: string | null): string {
  if (!key) return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string | null, value: string): void {
  if (!key) return;
  try {
    if (value.trim()) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode / quota — drafts are best-effort */
  }
}

// `@` 引用的 chip 跟草稿一起按会话存（同一 key 加 `:refs` 后缀），切会话 / 刷新不丢。
function readDraftRefs(key: string | null): NodeRef[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(`${key}:refs`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is NodeRef =>
          !!r && typeof r === "object" && typeof r.sessionId === "string" && typeof r.nodeId === "string" && typeof r.title === "string",
      )
      .slice(0, MAX_NODE_REFS);
  } catch {
    return [];
  }
}

function writeDraftRefs(key: string | null, refs: NodeRef[]): void {
  if (!key) return;
  try {
    if (refs.length > 0) localStorage.setItem(`${key}:refs`, JSON.stringify(refs));
    else localStorage.removeItem(`${key}:refs`);
  } catch {
    /* best-effort，同草稿 */
  }
}

export function Composer({
  targetNode,
  placeholder,
  onSubmitted,
  onEscape,
  focusToken,
  mobileCompact = false,
  fork = false,
  onMobileExpandedChange,
  targetIndex,
  banner,
}: {
  // The node a submit branches from (thread tip in linear view, the active
  // node on canvas). null → composer renders disabled.
  targetNode: ChatNode | null;
  fork?: boolean;
  placeholder?: string;
  // Fired right after a submit dispatches — the linear view uses it to drop
  // its "branch from #N" retarget chip so the next turn goes to the tip.
  onSubmitted?: () => void;
  // Esc inside the textarea (local semantics — useEscapeAbort leaves
  // textareas alone). Linear view: dismiss the retarget chip.
  onEscape?: () => void;
  // Bump to pull focus into the textarea (e.g. after arming a branch chip).
  focusToken?: number | null;
  // Linear reading view only: phones start as a one-line rail and reveal the
  // attachment/sketch surface after focus. Canvas keeps its existing shape.
  mobileCompact?: boolean;
  onMobileExpandedChange?: (expanded: boolean) => void;
  /** 「发送到」里显示的节点序号（线性视图传入） */
  targetIndex?: number | string;
  /** 卡内顶部横幅（分叉目标 chip 等） */
  banner?: ReactNode;
}) {
  const [text, setText] = useState("");
  // `@` 引用的其他会话 / 节点（lib/node-refs.ts），发送时序列化成标记追加到问题末尾。
  const [refs, setRefs] = useState<NodeRef[]>([]);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const emptyExternal = useSessionStore(s => s.session?.origin === "external" && Object.keys(s.nodes).length === 0);
  const abortStream = useSessionStore((s) => s.abortStream);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isStreaming = targetNode?.status === "streaming";
  // Before the server's `created` event lands, the streaming card is a local
  // optimistic placeholder — there's no run to abort yet.
  const isPending = targetNode ? isOptimisticNodeId(targetNode.id) : false;
  // Same tool-capability gate as skills (and the chat route's attachment
  // handling): project/enhanced chat take any whitelisted file
  // (staged to disk for the agent); pure chat only images + inlineable text.
  const toolCapable = sessionMode !== "chat" || chatEnhanced;
  const provider = useSessionStore((s) => s.provider);
  const family = providerFamily(provider);
  const workspacePath = useSessionStore((s) => s.session?.workspacePath);
  const skillProvider = family === "codex" ? "codex" : "claude";
  const skillPrefix = family === "codex" ? "$" : "/";
  // Picking a skill in pure chat auto-enables 增强模式 so the skill has the
  // tools it may need. Invocation syntax stays native to each CLI family.
  const matchedSkills = useSkillSuggestions(
    text,
    family !== "mock",
    skillProvider,
    workspacePath,
  );
  // S88: `@slug` single-turn delegation. Both real provider families resolve
  // the same Agent abstraction; mock stays hidden.
  const matchedAgents = useAgentMentions(
    text,
    family !== "mock",
  );
  const att = useAttachmentUploads(toolCapable ? "all" : "chat-safe");
  // 选完文件 / 拍完照：手机收起态展开，让附件预览露出来（和拖入一致）。
  const picker = useAttachPicker({
    accept: att.accept,
    onPicked: (e) => {
      att.handlePicked(e);
      if (mobileCompact) setMobileExpanded(true);
    },
  });
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // C1: Trellis commands in the docked composer — first-class in every mode
  // (skills stay gated on toolCapable). A bare /command runs locally against
  // the store and never streams; same registry + interception contract as the
  // first-screen QuestionInput.
  const session = useSessionStore((s) => s.session);
  const externalEnded = session?.origin === "external" && session.externalStatus === "closed";
  const newConversation = useSessionStore((s) => s.newConversation);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const setProvider = useSessionStore((s) => s.setProvider);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);
  // Transient note when a command no-ops (e.g. unknown /model arg) or echoes
  // its usage. Cleared on the next keystroke.
  const [cmdNotice, setCmdNotice] = useState<string | null>(null);
  const matchedCommands = matchCommands(text);
  // `@` 引用会话 / 节点：与 `/` 补全互斥（有命令 / 技能命中时不出）；与 @agent 同屏。
  const nodeRefs = useNodeRefMentions(
    text,
    matchedCommands.length === 0 && matchedSkills.length === 0 && refs.length < MAX_NODE_REFS,
  );
  const refItems = nodeRefs.items;

  // Drafts: `loadedKey` is the session the current text belongs to. Swapping
  // it during render (not in an effect) means text and key always change in
  // the same pass, so the save effect can never write the previous session's
  // text under the new key.
  const draftKey = session?.id ? sessionScopedKey.draft(session.id) : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (loadedKey !== draftKey) {
    setLoadedKey(draftKey);
    setText(readDraft(draftKey));
    setRefs(readDraftRefs(draftKey));
  }
  useEffect(() => {
    writeDraft(loadedKey, text);
  }, [text, loadedKey]);
  useEffect(() => {
    writeDraftRefs(loadedKey, refs);
  }, [refs, loadedKey]);
  // For async callbacks (send-failure refill) to see the live session.
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    loadedKeyRef.current = loadedKey;
  }, [loadedKey]);
  // 外部投递到本会话的文本（diff 审阅「发送给 agent」）：追加进草稿、聚焦，不自动发送。
  const pendingInsert = useComposerInsertStore((s) => s.pending);
  const [appliedInsertId, setAppliedInsertId] = useState<number | null>(null);
  if (pendingInsert && pendingInsert.sessionId === session?.id && loadedKey === draftKey && appliedInsertId !== pendingInsert.id) {
    setAppliedInsertId(pendingInsert.id);
    setText((cur) => appendToDraft(cur, pendingInsert.text));
  }
  useEffect(() => {
    if (appliedInsertId === null) return;
    useComposerInsertStore.getState().consumeComposerInsert(appliedInsertId);
    ref.current?.focus();
  }, [appliedInsertId]);

  const commandStore: CommandStore = {
    session,
    newConversation,
    archiveSession,
    setSearchOpen,
    setComposeRootOpen,
    setProvider,
    provider,
    providerCatalog,
  };

  // Shared by submit-interception and dropdown pick: run a command, echo its
  // note inline (keeping the input for correction) or reset on success.
  const runCommand = (command: Command, args: string) => {
    const note = command.run(commandStore, args);
    if (note) {
      setCmdNotice(note);
      ref.current?.focus();
    } else {
      setText("");
      setCmdNotice(null);
    }
  };

  // Dropdown pick actions, shared by mouse click and keyboard (Enter/Tab).
  // Same convention as QuestionInput: /model takes an argument → fill
  // "/model " for typing; other commands run immediately; skills fill
  // "/name " for claude to execute natively on send.
  const pickCommand = (c: Command) => {
    if (c.name === "model") {
      setText(`/${c.name} `);
      ref.current?.focus();
      return;
    }
    runCommand(c, "");
  };
  const pickSkill = (name: string) => {
    // Pure chat spawns without tools (WebSearch/WebFetch only) — a skill sent
    // there can't execute. Flip 增强模式 on pick so the coming turn spawns
    // with full tools; the Header badge reflects it and the notice says why.
    if (!toolCapable) {
      setChatEnhanced(true);
      setCmdNotice("已自动开启增强模式：技能需要工具，工具调用自动批准（本轮起生效）");
    }
    setText(`${skillPrefix}${name} `);
    ref.current?.focus();
  };
  const pickAgent = (slug: string) => {
    setText(`@${slug} `);
    ref.current?.focus();
  };
  const pickRef = (item: RefPickItem) => {
    const picked = refFromItem(item);
    // 会话还没有已完成节点：展开看看（列表为空即不可引用）。
    if (!picked) return nodeRefs.toggleExpand(item.session.sessionId);
    setRefs((cur) =>
      cur.some((r) => r.nodeId === picked.nodeId) ? cur : [...cur, picked].slice(0, MAX_NODE_REFS),
    );
    setText((cur) => removeMentionQuery(cur));
    nodeRefs.collapse();
    ref.current?.focus();
  };
  const removeRef = (nodeId: string) => setRefs((cur) => cur.filter((r) => r.nodeId !== nodeId));
  // agents 与 commands/skills 互斥出现（`@` vs `/`），所以三者共用一个平坦的
  // 索引空间不会串味：有 agent 时另两个必为空，反之亦然。`@` 引用的会话行排在
  // agents 之后（同样只在没有命令 / 技能命中时出现）。
  const slashNav = useSlashNav(
    matchedCommands.length + matchedSkills.length + matchedAgents.length + refItems.length,
    text,
    (i) => {
      if (i < matchedAgents.length) return pickAgent(matchedAgents[i].slug);
      if (matchedAgents.length || refItems.length) return pickRef(refItems[i - matchedAgents.length]);
      return i < matchedCommands.length
        ? pickCommand(matchedCommands[i])
        : pickSkill(matchedSkills[i - matchedCommands.length].name);
    },
  );

  useEffect(() => {
    onMobileExpandedChange?.(mobileCompact && mobileExpanded);
  }, [mobileCompact, mobileExpanded, onMobileExpandedChange]);

  // ── 回复进行中：排队 / 插话 ───────────────────────────────────────────────
  const sessionId = session?.id ?? null;
  const queue = useSessionQueue(sessionId);
  const updateQueue = useComposerQueueStore((s) => s.update);
  const busySendMode = useSessionStore((s) => s.busySendMode);
  const [steering, setSteering] = useState(false);
  const targetId = targetNode?.id ?? null;
  const targetParentId = targetNode?.parentId ?? null;
  const targetStatus = targetNode?.status ?? null;
  const queueTarget: QueueTarget | null =
    targetId && targetStatus
      ? { id: targetId, parentId: targetParentId, status: targetStatus, optimistic: isPending }
      : null;
  // 事件回调（异步插话回退、取消、继续发送）要看见最新的目标。
  const queueTargetRef = useRef<QueueTarget | null>(queueTarget);
  useEffect(() => {
    queueTargetRef.current = queueTarget;
  });

  // 出队发送：总是接在刚结束的那个节点后面（非分叉），@slug 照常剥出。
  const dispatchQueued = (action: QueueAction) => {
    const sid = sessionId;
    const { item, targetId: parent } = action;
    const [mentionAgentSlug, question] = splitMention(item.text.trim());
    const sent = streamBranch(parent, question, null, {
      attachments: item.attachments.length > 0 ? item.attachments : undefined,
      mentionAgentSlug,
    });
    // 没落地：放回队首并暂停，不丢字。
    void sent.then((ok) => {
      if (!ok && sid) updateQueue(sid, (q) => requeueFailed(q, item, parent));
    });
  };
  const dispatchRef = useRef(dispatchQueued);
  useEffect(() => {
    dispatchRef.current = dispatchQueued;
  });

  /** 推进队列一步，并用当前目标立刻 observe 一次（入队时目标可能已经结束）。 */
  const commitQueue = (next: (q: ComposerQueue) => ComposerQueue) => {
    if (!sessionId) return;
    let action: QueueAction | null = null;
    updateQueue(sessionId, (q) => {
      const step = observeQueue(next(q), queueTargetRef.current);
      action = step.action;
      return step.queue;
    });
    if (action) dispatchRef.current(action);
  };

  // 目标的 id / 状态 / 乐观态一变就 observe：当前轮成功结束 → 发队首；出错 → 暂停。
  // 首次进会话顺带从 localStorage 载入（update 对未加载的会话会先 load）。
  useEffect(() => {
    if (!sessionId) return;
    const target: QueueTarget | null =
      targetId && targetStatus
        ? { id: targetId, parentId: targetParentId, status: targetStatus, optimistic: isPending }
        : null;
    let action: QueueAction | null = null;
    updateQueue(sessionId, (q) => {
      const step = observeQueue(q, target);
      action = step.action;
      return step.queue;
    });
    if (action) dispatchRef.current(action);
  }, [sessionId, targetId, targetParentId, targetStatus, isPending, updateQueue]);

  const steerAvailable =
    Boolean(isStreaming && targetNode) &&
    !isPending &&
    session?.bindingType === "thread" &&
    session.origin !== "external";

  const resetAfterSend = () => {
    setText("");
    setRefs([]);
    att.clear();
    onSubmitted?.();
    if (mobileCompact) setMobileExpanded(false);
  };

  const enqueueMessage = (message: string, attachments: QueuedMessage["attachments"]) => {
    const target = queueTargetRef.current;
    if (!target) return;
    const item = newQueuedMessage(message, attachments);
    commitQueue((q) => enqueue(q, item, target));
  };

  const steer = async (message: string, nodeId: string) => {
    const key = loadedKey;
    // 输入框还是这条会话、且用户没开始写新的，才把文字放回去。
    const refill = () => {
      if (loadedKeyRef.current === key) setText((cur) => (cur.trim() ? cur : message));
    };
    resetAfterSend();
    setSteering(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/as/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      if (res.ok) {
        setCmdNotice("已插话：会在当前步骤结束后送达这一轮");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; steerable?: boolean };
      if (res.status === 409 && data.steerable === false) {
        if (loadedKeyRef.current === key) {
          enqueueMessage(message, []);
          setCmdNotice(`${data.error ?? "这一轮不能插话"}：已改为排队`);
        } else refill();
        return;
      }
      refill();
      setCmdNotice(`插话失败：${data.error ?? res.status}`);
    } catch (error) {
      refill();
      setCmdNotice(`插话失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSteering(false);
    }
  };

  const submit = (busyMode?: BusySendMode) => {
    const trimmed = text.trim();
    // 只有引用、没写字也能发（「看看这个」式的引用本身就是问题）。
    if (!trimmed && refs.length === 0) return;
    // C1: intercept bare Trellis commands BEFORE any send-to-LLM path — they
    // don't need a target node (/new, /switch work even mid-stream). Skill
    // commands aren't in the registry → parseCommand null → fall through.
    const parsed = refs.length === 0 ? parseCommand(trimmed) : null;
    if (parsed) {
      runCommand(parsed.command, parsed.args);
      return;
    }
    if ((!targetNode && !emptyExternal) || att.hasUploading || externalEnded) return;
    const attachments =
      att.doneAttachments.length > 0 ? att.doneAttachments : undefined;
    if (isStreaming && targetNode) {
      const mode = busyMode ?? (steerAvailable ? busySendMode : "queue");
      // 插话只带文字、不带 @提及（提及是单独一轮的定向委派）；带 `@` 引用的也改排队
      // （插话直接注入 Agent 服务，不经 chat 路由的引用注入）。
      if (mode === "steer" && steerAvailable && !attachments && !splitMention(trimmed)[0] && refs.length === 0) {
        void steer(trimmed, targetNode.id);
      } else {
        // 排队消息带着引用标记，出队时照常经 chat 路由解析注入。
        enqueueMessage(appendNodeRefs(trimmed, refs), attachments ?? []);
        resetAfterSend();
      }
      return;
    }
    const sentRefs = refs;
    setText("");
    setRefs([]);
    // This composer stays mounted after submit — clear so the next turn
    // starts fresh.
    att.clear();
    // S88: 剥出开头的 `@slug` —— slug 走 body 字段，剩下的才是问题本身。
    // `@` 引用：标记追加在问题末尾（lib/node-refs.ts），服务端按 id 现取内容注入。
    const [mentionAgentSlug, question] = splitMention(trimmed);
    const sent = targetNode
      ? streamBranch(targetNode.id, appendNodeRefs(question, sentRefs), null, { attachments, mentionAgentSlug, fork })
      : streamRoot(appendNodeRefs(trimmed, sentRefs), { attachToCurrentSession: true, attachments });
    // Never acknowledged → hand the text back, unless the user has already
    // started something new or moved to another session meanwhile.
    const key = loadedKey;
    void sent.then((ok) => {
      if (ok || loadedKeyRef.current !== key) return;
      setText((cur) => (cur.trim() ? cur : text));
      setRefs((cur) => (cur.length > 0 ? cur : sentRefs));
    });
    onSubmitted?.();
    if (mobileCompact) setMobileExpanded(false);
  };

  const cancelQueued = (id: string) => {
    if (!sessionId) return;
    let removed: QueuedMessage | null = null;
    updateQueue(sessionId, (q) => {
      const r = removeQueued(q, id);
      removed = r.removed;
      return r.queue;
    });
    const back = removed as QueuedMessage | null;
    if (!back) return;
    // 退回输入框：输入框里已有文字就接在后面，别覆盖用户正在写的。
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${back.text}` : back.text));
    if (back.attachments.length > 0) att.restore(back.attachments);
    if (mobileCompact) setMobileExpanded(true);
    window.requestAnimationFrame(() => ref.current?.focus());
  };

  const resumeQueued = () => {
    if (!sessionId) return;
    let action: QueueAction | null = null;
    updateQueue(sessionId, (q) => {
      const step = resumeQueue(q, queueTargetRef.current);
      action = step.action;
      return step.queue;
    });
    if (action) dispatchRef.current(action);
  };

  const compact = mobileCompact && !mobileExpanded;
  const noTarget = !targetNode && !emptyExternal;
  const streaming = Boolean(isStreaming && targetNode);
  const hasDraft = !!text.trim() || refs.length > 0;
  const canSend =
    hasDraft && !noTarget && !att.hasUploading && !externalEnded && !steering;
  const targetLabel = targetNode
    ? (targetNode.topicLabel ?? targetNode.question).replace(/\s+/g, " ").trim()
    : null;
  // 运行中主按钮代表的方式：插话不可用时一律排队。
  const busyPrimary: BusySendMode = steerAvailable ? busySendMode : "queue";
  const busySecondary: BusySendMode | null = steerAvailable
    ? busyPrimary === "queue"
      ? "steer"
      : "queue"
    : null;
  const hint = streaming
    ? isPending
      ? "正在建立连接…可以先写，发送会排队"
      : busyPrimary === "steer"
        ? "回复进行中：发送会插话进这一轮（可改为排队）· Esc 停止"
        : `回复进行中：发送会排队，本轮结束后自动发出${steerAvailable ? "（可改为插话）" : ""} · Esc 停止`
    : sendHint(sendKey) + (compact ? "" : " · 输入 / 调出命令 · @ 引用会话 · 可粘贴 / 拖入图片与文件");

  const status = queueStatus(queue, queueTarget);
  const queueItems: ComposerQueueItem[] = queue.items.map((item, i) => ({
    id: item.id,
    text: item.text,
    label: i === 0 && status === "paused" ? "已暂停" : "排队中",
    meta: item.attachments.length > 0 ? `+${item.attachments.length} 附件` : undefined,
    onEdit: (next) => commitQueue((q) => editQueued(q, item.id, next)),
    actions: [{ label: "取消", tone: "danger" as const, onClick: () => cancelQueued(item.id) }],
  }));
  const queueHeader =
    status === "paused" || status === "waiting" ? (
      <div
        data-composer-queue-status={status}
        role="status"
        className="flex min-h-8 items-center gap-2 border-b border-line-faint pl-2 pr-0.5 pb-1 mb-1 text-label text-warn-ink max-md:min-h-11"
      >
        <span className="min-w-0 flex-1">
          {status === "paused"
            ? "已暂停：上一轮出错或被停止，排队消息没有自动发出"
            : "排队消息在等待：当前目标不是它们排在后面的那一轮"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-composer-queue-resume=""
          onClick={resumeQueued}
          disabled={!queueTarget || queueTarget.optimistic}
          className="shrink-0"
        >
          {queueTarget?.status === "streaming" ? "本轮结束后发送" : "继续发送"}
        </Button>
      </div>
    ) : status === "auto" ? (
      <div
        data-composer-queue-status="auto"
        className="px-2 pb-0.5 text-label text-ink-faint max-md:hidden"
      >
        当前轮结束后自动依次发出 · {queue.items.length} 条
      </div>
    ) : undefined;

  // ── 输入框上方状态条：排队 · 上下文用量（Project 模式，与 Header 同口径）· 本轮后台任务 ──
  const [queueOpenPref, setQueueOpen] = useState(false);
  const queueOpen = queueOpenPref && queue.items.length > 0;
  const contextWindow = contextWindowFor(provider);
  // 选 token 数（原始值）而不是对象，selector 结果才可比较、不会每次都触发重渲染。
  const ctxTokens = useSessionStore((s) =>
    s.session?.mode === "project" ? (contextUsageFor(targetId, s.nodes, contextWindow)?.tokens ?? 0) : 0,
  );
  const context =
    ctxTokens > 0 ? { tokens: ctxTokens, percent: Math.min(100, (ctxTokens / contextWindow) * 100), contextWindow } : null;
  const statusPills = composerStatusPills({
    queue: { count: queue.items.length, status },
    context,
    background: runningBackgroundTasks(isStreaming ? targetNode?.toolCalls : undefined),
  });

  const busyMeta = {
    queue: { label: "排队", aria: "排队发送", tip: "排队：本轮结束后自动发出", icon: ListPlus },
    steer: { label: "插话", aria: "插话发送", tip: "插话：注入正在进行的这一轮", icon: CornerDownRight },
  } as const;
  const steerBlocked = (mode: BusySendMode) =>
    mode === "steer" && (att.doneAttachments.length > 0 || att.pending.length > 0)
      ? "插话暂不支持附件，可以排队"
      : mode === "steer" && refs.length > 0
        ? "插话暂不支持 @ 引用，可以排队"
        : null;

  // 主按钮同位互换（参考 Cindy mobile）：同一颗按钮、同一个位置，按状态换语义——
  //   空闲            = 发送；
  //   运行中、没草稿  = 停止（方形图标）；
  //   运行中、有草稿  = 发送（排队 / 插话按 busySendMode，语义同前），停止退到主按钮
  //                     左侧一个小槽（手机 36px 视觉 / 44px 热区）；另一种方式（通常是
  //                     插话）是展开态里主按钮左边的次要入口——手机收起态不放。
  //   连接中 / 上传中 = 加载。
  // 图标在同一格里交叉淡变 + 缩放（globals.css .morph-icon，150ms）。停止态
  // aria-label 固定「停止生成」（mobile-followup-approval.sh 依赖），手机 ≥44px。
  // 桌面布局不变：有草稿时停止仍排在最右（md:order-last）。
  const stopNow = streaming && !hasDraft;
  const mainIcon: "send" | "stop" | "queue" | "steer" | "loading" =
    (stopNow && isPending) || (!stopNow && (att.hasUploading || steering))
      ? "loading"
      : stopNow
        ? "stop"
        : streaming
          ? busyPrimary
          : "send";
  const mainTip = stopNow
    ? isPending
      ? "正在建立连接…"
      : "停止生成"
    : att.hasUploading
      ? "等待附件上传…"
      : streaming
        ? (steerBlocked(busyPrimary) ?? busyMeta[busyPrimary].tip)
        : "发送";
  const mainButton = (
    <Tooltip
      content={mainTip}
      shortcut={stopNow ? (isPending ? undefined : "Esc") : sendKey === "enter" ? "↩" : ["⌘", "↩"]}
      side="top"
    >
      <Button
        // bui send：30px 墨色圆钮；停止态同一颗、同一位置，换成方块。
        variant="ink"
        size="icon"
        aria-label={stopNow ? "停止生成" : streaming ? busyMeta[busyPrimary].aria : "发送"}
        data-composer-primary={
          stopNow ? (isPending ? "loading" : "stop") : streaming ? undefined : att.hasUploading ? "loading" : "send"
        }
        data-composer-busy-send={streaming && !stopNow ? busyPrimary : undefined}
        onClick={() => (stopNow ? abortStream(targetNode!.id) : submit(streaming ? busyPrimary : undefined))}
        disabled={stopNow ? isPending : !canSend}
        className="shrink-0 rounded-full! md:min-h-7.5 md:min-w-7.5"
      >
        <span className="morph-icon" aria-hidden>
          <Icon icon={ArrowUp} size="md" selected data-active={mainIcon === "send" ? "" : undefined} />
          <Square size={10} strokeWidth={0} fill="currentColor" data-active={mainIcon === "stop" ? "" : undefined} />
          <Icon icon={ListPlus} size="md" selected data-active={mainIcon === "queue" ? "" : undefined} />
          <Icon icon={CornerDownRight} size="md" selected data-active={mainIcon === "steer" ? "" : undefined} />
          {/* 转圈只在加载态挂（常驻会一直跑 animate-spin） */}
          <span className="inline-grid" data-active={mainIcon === "loading" ? "" : undefined}>
            {mainIcon === "loading" && <Spinner size="sm" label={null} className="text-current" />}
          </span>
        </span>
      </Button>
    </Tooltip>
  );
  // 有草稿时退到主按钮左侧的小停止槽。手机：44px 透明热区里一枚 36px 圆形；
  // 桌面：和原来一样的描边图标按钮，排在最右。
  const stopSlot = streaming && hasDraft && (
    <Tooltip content={isPending ? "正在建立连接…" : "停止生成"} shortcut={isPending ? undefined : "Esc"} side="top">
      <Button
        variant="secondary"
        size="icon"
        aria-label="停止生成"
        data-composer-primary={isPending ? "loading" : "stop"}
        data-composer-stop-slot=""
        onClick={() => abortStream(targetNode!.id)}
        disabled={isPending}
        className="shrink-0 rounded-full! md:order-last md:min-h-7.5 md:min-w-7.5 max-md:bg-transparent max-md:shadow-none max-md:active:bg-transparent"
      >
        <span className="md:contents max-md:grid max-md:size-9 max-md:place-items-center max-md:rounded-full max-md:border max-md:border-line-strong max-md:bg-surface">
          {isPending ? (
            <Spinner size="sm" label={null} />
          ) : (
            <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
          )}
        </span>
      </Button>
    </Tooltip>
  );
  const busySecondaryButton = busySecondary && (
    <Tooltip content={steerBlocked(busySecondary) ?? busyMeta[busySecondary].tip} side="top">
      <Button
        variant="ghost"
        size="sm"
        aria-label={busyMeta[busySecondary].aria}
        data-composer-busy-send={busySecondary}
        onClick={() => submit(busySecondary)}
        disabled={!canSend || !!steerBlocked(busySecondary)}
        className="shrink-0 rounded-full! md:min-h-7 md:text-[12.5px]"
      >
        <Icon icon={busyMeta[busySecondary].icon} size="sm" />
        {busyMeta[busySecondary].label}
      </Button>
    </Tooltip>
  );
  // 槽位固定（false 占位），主按钮在各状态间是同一个 fiber，图标才能原地过渡。
  const primary = (
    <>
      {streaming && hasDraft && !compact && busySecondaryButton}
      {stopSlot}
      {mainButton}
    </>
  );

  const attachButton = (
    <ComposerAttachButton
      openFiles={picker.openFiles}
      openCamera={picker.openCamera}
      disabled={noTarget || att.atLimit}
      atLimit={att.atLimit}
      onMenuOpenChange={setAttachMenuOpen}
    />
  );

  return (
    <ComposerShell
      textareaRef={ref}
      value={text}
      onValueChange={(value) => {
        setText(value);
        if (cmdNotice) setCmdNotice(null);
      }}
      onSubmit={submit}
      onEscape={onEscape}
      sendKey={sendKey}
      onSlashKeyDown={slashNav.handleKeyDown}
      suggestions={
        (matchedCommands.length > 0 ||
          matchedSkills.length > 0 ||
          matchedAgents.length > 0 ||
          refItems.length > 0) && (
          <SkillPickerList
            skills={matchedSkills}
            onPick={pickSkill}
            commands={matchedCommands}
            onPickCommand={pickCommand}
            agents={matchedAgents}
            onPickAgent={pickAgent}
            refItems={refItems}
            onPickRef={pickRef}
            refExpandedId={nodeRefs.expandedId}
            refExpandedLoading={nodeRefs.expandedLoading}
            onToggleRefExpand={nodeRefs.toggleExpand}
            activeIndex={slashNav.active}
            skillPrefix={skillPrefix}
          />
        )
      }
      disabled={noTarget || externalEnded}
      placeholder={externalEnded ? "外部线程已结束" : (placeholder ?? "继续对话…")}
      compactPlaceholder={externalEnded ? "外部线程已结束" : "追问…"}
      mobileCompact={mobileCompact}
      mobileExpanded={mobileExpanded}
      onMobileExpandedChange={setMobileExpanded}
      keepExpanded={Boolean(
        text.trim() ||
          refs.length > 0 ||
          att.pending.length > 0 ||
          att.doneAttachments.length > 0 ||
          att.notice ||
          cmdNotice ||
          sketchOpen ||
          attachMenuOpen,
      )}
      focusToken={focusToken}
      banner={banner}
      attachments={
        (refs.length > 0 || att.pending.length > 0) && (
          <div className="px-3 pt-2.5 flex flex-col gap-2">
            <NodeRefChips refs={refs} onRemove={removeRef} />
            {att.pending.length > 0 && (
              <AttachmentPreview pending={att.pending} onRemove={att.remove} />
            )}
          </div>
        )
      }
      onPaste={att.handlePaste}
      onDropFiles={att.handleDrop}
      chips={
        <>
          <ModeBadge />
          <ModelPicker />
        </>
      }
      tools={
        <>
          {attachButton}
          <IconButton
            label="画个草图"
            title={att.atLimit ? "已到附件上限" : "画个草图（导出为图片附件）"}
            onClick={() => setSketchOpen(true)}
            disabled={noTarget || att.atLimit}
            className={COMPOSER_TOOL_ICON}
          >
            <Icon icon={PenLine} />
          </IconButton>
        </>
      }
      compactTools={attachButton}
      sendTo={
        targetLabel && (
          <Tooltip content="新消息会接在这个节点之后" side="top">
            <span
              tabIndex={0}
              data-composer-send-to=""
              className="hidden sm:inline-flex min-w-0 max-w-64 items-center gap-1 mr-1.5 rounded-full px-1 text-[12.5px] text-ink-faint"
            >
              <Icon icon={GitBranch} size="sm" className={fork ? "text-fork" : undefined} />
              <span className="shrink-0">发送到：</span>
              <b className="min-w-0 truncate font-medium text-ink-muted">{targetLabel}</b>
              {targetIndex !== undefined && (
                <span className="shrink-0 font-mono tabular-nums">#{targetIndex}</span>
              )}
            </span>
          </Tooltip>
        )
      }
      primary={primary}
      state={streaming ? "stopping" : compact ? "compact" : "expanded"}
      queue={queueItems}
      queueHeader={queueHeader}
      queueOpen={queueOpen}
      statusBar={
        statusPills.length > 0 && (
          <ComposerStatusBar
            pills={statusPills}
            queueOpen={queueOpen}
            onToggleQueue={() => setQueueOpen(!queueOpen)}
            context={context}
            onStartFresh={() => setComposeRootOpen(true)}
          />
        )
      }
      fullscreen={{
        submitLabel: streaming ? busyMeta[busyPrimary].label : "发送",
        submitDisabled: !canSend,
      }}
      notice={cmdNotice ?? att.notice}
      hintLeft={streaming ? hint : ""}
      hintRight={streaming ? "" : hint}
      beforeCard={picker.inputs}
      afterCard={
        sketchOpen && (
          <SketchModal
            onClose={() => setSketchOpen(false)}
            onExport={(blob) => att.startUpload(blob, "sketch.png")}
          />
        )
      }
    />
  );
}
