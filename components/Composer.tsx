"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, GitBranch, Paperclip, PenLine, Square } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { matchCommands, parseCommand, type Command, type CommandStore } from "@/lib/commands";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { useAgentMentions, splitMention } from "@/hooks/useAgentMentions";
import { providerFamily } from "@/lib/llm";
import { useSlashNav } from "@/hooks/useSlashNav";
import { useAttachmentUploads } from "@/hooks/useAttachmentUploads";
import { SkillPickerList } from "./SkillPickerList";
import { AttachmentPreview } from "./AttachmentPreview";
import { SketchModal } from "./SketchModal";
import { isOptimisticNodeId } from "@/stores/sessionStore";
import { Button, Icon, IconButton, Spinner, Tooltip } from "@/components/ui";
import { ModeBadge } from "./ModeBadge";
import { ModelPicker } from "./ModelPicker";
import type { ChatNode } from "@/lib/types";

// #3/#7: the shared always-docked composer. Used by the linear thread's
// sticky footer and the canvas's fixed bottom bar.
//
// W3：单一卡片式输入（描边卡 + 聚焦描边环）。卡内：可选横幅（分叉目标）→
// 附件 → 输入框 → 底栏（模式 chip · 模型 · 附件 / 手绘 ghost 图标 ·「发送到」·
// 主按钮）；卡外一行弱化提示（状态 + 快捷键）。主按钮三态合一：空闲 = 发送、
// 流式 = 停止、连接中 / 上传中 = 加载。流式时输入框不再被停止按钮替换 ——
// 可以先写好下一条，回合结束再发（没有排队后端，所以流式中不发送）。
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
  // 输入法组字保护：组字中的 Enter（isComposing / keyCode 229）不发送；
  // Safari 在 compositionend 之后还会补发一次 keydown(Enter)，再挡 100ms。
  const compositionEndAt = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // agents 与 commands/skills 互斥出现（`@` vs `/`），所以三者共用一个平坦的
  // 索引空间不会串味：有 agent 时另两个必为空，反之亦然。
  const slashNav = useSlashNav(
    matchedCommands.length + matchedSkills.length + matchedAgents.length,
    text,
    (i) => {
      if (matchedAgents.length) return pickAgent(matchedAgents[i].slug);
      return i < matchedCommands.length
        ? pickCommand(matchedCommands[i])
        : pickSkill(matchedSkills[i - matchedCommands.length].name);
    },
  );

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
    }
  }, [text, mobileCompact, mobileExpanded]);

  useEffect(() => {
    onMobileExpandedChange?.(mobileCompact && mobileExpanded);
  }, [mobileCompact, mobileExpanded, onMobileExpandedChange]);

  useEffect(() => {
    if (focusToken == null) return;
    const id = window.requestAnimationFrame(() => {
      if (mobileCompact) setMobileExpanded(true);
      ref.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusToken, mobileCompact]);

  const expandMobile = () => {
    if (mobileCompact) setMobileExpanded(true);
  };

  const collapseMobileIfEmpty = () => {
    if (!mobileCompact) return;
    window.requestAnimationFrame(() => {
      if (rootRef.current?.contains(document.activeElement)) return;
      if (
        text.trim() ||
        att.pending.length > 0 ||
        att.doneAttachments.length > 0 ||
        att.notice ||
        cmdNotice ||
        sketchOpen
      ) {
        return;
      }
      setMobileExpanded(false);
    });
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // C1: intercept bare Trellis commands BEFORE any send-to-LLM path — they
    // don't need a target node (/new, /switch work even mid-stream). Skill
    // commands aren't in the registry → parseCommand null → fall through.
    const parsed = parseCommand(trimmed);
    if (parsed) {
      runCommand(parsed.command, parsed.args);
      return;
    }
    if ((!targetNode && !emptyExternal) || isStreaming || att.hasUploading || externalEnded) return;
    const attachments =
      att.doneAttachments.length > 0 ? att.doneAttachments : undefined;
    setText("");
    // This composer stays mounted after submit — clear so the next turn
    // starts fresh.
    att.clear();
    // S88: 剥出开头的 `@slug` —— slug 走 body 字段，剩下的才是问题本身。
    const [mentionAgentSlug, question] = splitMention(trimmed);
    if (targetNode) streamBranch(targetNode.id, question, null, { attachments, mentionAgentSlug, fork });
    else void streamRoot(trimmed,{attachToCurrentSession:true,attachments});
    onSubmitted?.();
    if (mobileCompact) setMobileExpanded(false);
  };

  const compact = mobileCompact && !mobileExpanded;
  const noTarget = !targetNode && !emptyExternal;
  const streaming = Boolean(isStreaming && targetNode);
  const canSend =
    !streaming && !!text.trim() && !noTarget && !att.hasUploading && !externalEnded;
  const targetLabel = targetNode
    ? (targetNode.topicLabel ?? targetNode.question).replace(/\s+/g, " ").trim()
    : null;
  const hint = streaming
    ? isPending
      ? "正在建立连接…"
      : "回复进行中：可以先写下一条，结束后再发送 · Esc 停止"
    : sendHint(sendKey) + (compact ? "" : " · 输入 / 调出命令 · 可粘贴图片 / 文件");

  // 主按钮三态合一：发送 / 停止 / 加载。停止态 aria-label 固定「停止生成」
  // （mobile-followup-approval.sh 依赖），手机 ≥44px。
  const primary = streaming ? (
    <Tooltip content={isPending ? "正在建立连接…" : "停止生成"} shortcut={isPending ? undefined : "Esc"} side="top">
      <Button
        variant="secondary"
        size="icon"
        aria-label="停止生成"
        data-composer-primary={isPending ? "loading" : "stop"}
        onClick={() => abortStream(targetNode!.id)}
        disabled={isPending}
        className="shrink-0"
      >
        {isPending ? (
          <Spinner size="sm" label={null} />
        ) : (
          <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden />
        )}
      </Button>
    </Tooltip>
  ) : (
    <Tooltip
      content={att.hasUploading ? "等待附件上传…" : "发送"}
      shortcut={sendKey === "enter" ? "↩" : ["⌘", "↩"]}
      side="top"
    >
      <Button
        variant="primary"
        size="icon"
        aria-label="发送"
        data-composer-primary={att.hasUploading ? "loading" : "send"}
        onClick={submit}
        disabled={!canSend}
        className="shrink-0"
      >
        {att.hasUploading ? (
          <Spinner size="sm" label={null} className="text-current" />
        ) : (
          <Icon icon={ArrowUp} size="md" selected />
        )}
      </Button>
    </Tooltip>
  );

  const attachButton = (
    <IconButton
      label={att.atLimit ? "已到附件上限" : "添加图片 / 文件"}
      onClick={() => fileInputRef.current?.click()}
      disabled={noTarget || att.atLimit}
      data-composer-attach=""
    >
      <Icon icon={Paperclip} />
    </IconButton>
  );

  return (
    <div
      ref={rootRef}
      data-mobile-composer
      data-composer-state={streaming ? "stopping" : compact ? "compact" : "expanded"}
      className={`relative ${compact ? "py-1.5" : "pt-2 pb-3 max-md:py-2"}`}
      onBlur={collapseMobileIfEmpty}
    >
      {(matchedCommands.length > 0 ||
        matchedSkills.length > 0 ||
        matchedAgents.length > 0) && (
        <SkillPickerList
          skills={matchedSkills}
          onPick={pickSkill}
          commands={matchedCommands}
          onPickCommand={pickCommand}
          agents={matchedAgents}
          onPickAgent={pickAgent}
          activeIndex={slashNav.active}
          skillPrefix={skillPrefix}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={att.accept}
        multiple
        onChange={att.handlePicked}
        className="hidden"
      />
      <div
        data-composer-card=""
        className="rounded-card border border-line-strong bg-surface transition-[border-color,box-shadow] duration-100 focus-within:border-accent-line focus-within:ring-3 focus-within:ring-focus-ring"
      >
        {banner}
        {!compact && att.pending.length > 0 && (
          <div className="px-3 pt-2.5">
            <AttachmentPreview pending={att.pending} onRemove={att.remove} />
          </div>
        )}
        <div className={compact ? "flex items-center gap-1 pr-1" : undefined}>
          <textarea
            data-composer-input
            ref={ref}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (cmdNotice) setCmdNotice(null);
            }}
            onCompositionEnd={() => {
              compositionEndAt.current = Date.now();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && Date.now() - compositionEndAt.current < 100) return;
              // Suggestion navigation first — while the "/" dropdown is open,
              // Enter picks the highlighted item instead of sending.
              if (slashNav.handleKeyDown(e)) return;
              if (isSendCombo(e, sendKey)) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && onEscape) {
                e.preventDefault();
                onEscape();
              }
            }}
            onPaste={att.handlePaste}
            onFocus={expandMobile}
            rows={1}
            disabled={noTarget || externalEnded}
            placeholder={externalEnded ? "外部线程已结束" : compact ? "追问…" : (placeholder ?? "继续对话…")}
            className={`block w-full min-w-0 resize-none bg-transparent text-body text-ink-strong outline-none placeholder:text-ink-faint disabled:opacity-50 ${
              compact
                ? "flex-1 h-11 min-h-11 max-h-11 px-3 py-2.5"
                : "min-h-12 max-h-40 px-3.5 pt-3 pb-1 leading-relaxed max-md:min-h-18"
            }`}
          />
          {compact && (
            <>
              {attachButton}
              {primary}
            </>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            {!mobileCompact && (
              <div className="flex min-w-0 items-center gap-1.5 mr-1" data-composer-context="">
                <ModeBadge />
                <ModelPicker />
              </div>
            )}
            {attachButton}
            <IconButton
              label={att.atLimit ? "已到附件上限" : "画个草图（导出为图片附件）"}
              onClick={() => setSketchOpen(true)}
              disabled={noTarget || att.atLimit}
            >
              <Icon icon={PenLine} />
            </IconButton>
            <span className="flex-1" />
            {targetLabel && (
              <Tooltip content="新消息会接在这个节点之后" side="top">
                <span
                  tabIndex={0}
                  data-composer-send-to=""
                  className="hidden sm:inline-flex min-w-0 max-w-64 items-center gap-1 mr-1.5 text-label text-ink-faint"
                >
                  <Icon icon={GitBranch} size="sm" className={fork ? "text-fork" : undefined} />
                  <span className="shrink-0">发送到：</span>
                  <b className="min-w-0 truncate font-medium text-ink-muted">{targetLabel}</b>
                  {targetIndex !== undefined && (
                    <span className="shrink-0 font-mono tabular-nums">#{targetIndex}</span>
                  )}
                </span>
              </Tooltip>
            )}
            {primary}
          </div>
        )}
      </div>
      {sketchOpen && (
        <SketchModal
          onClose={() => setSketchOpen(false)}
          onExport={(blob) => att.startUpload(blob, "sketch.png")}
        />
      )}
      {(cmdNotice || att.notice) && (
        <div className="mt-1.5 px-1 text-label text-warn-ink" role="status">
          {cmdNotice ?? att.notice}
        </div>
      )}
      {!compact && (
        <div
          data-composer-hint=""
          className="mt-1.5 flex items-center justify-between gap-3 px-1 text-label text-ink-faint max-md:hidden"
        >
          <span className="min-w-0 truncate">{streaming ? hint : ""}</span>
          <span className="shrink-0">{streaming ? "" : hint}</span>
        </div>
      )}
    </div>
  );
}
