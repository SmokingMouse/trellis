"use client";
import { useEffect, useRef, useState } from "react";
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
import { StopButton } from "./ui/StopButton";
import type { ChatNode } from "@/lib/types";

// #3/#7: the shared always-docked composer. Used by the linear thread's
// sticky footer and the canvas's fixed bottom bar — one input surface with a
// STABLE height: while the target streams, the textarea swaps to an
// equal-height stop button instead of disappearing/resizing, so the bottom
// region never jumps.
export function Composer({
  targetNode,
  placeholder,
  onSubmitted,
  onEscape,
  focusToken,
  mobileCompact = false,
  onMobileExpandedChange,
}: {
  // The node a submit branches from (thread tip in linear view, the active
  // node on canvas). null → composer renders disabled.
  targetNode: ChatNode | null;
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
}) {
  const [text, setText] = useState("");
  const [sketchOpen, setSketchOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const abortStream = useSessionStore((s) => s.abortStream);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const ref = useRef<HTMLTextAreaElement>(null);
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
      setCmdNotice("⚡ 已自动开启增强模式 — 技能需要工具（YOLO，本轮起生效）");
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
    if (!targetNode || isStreaming || att.hasUploading) return;
    const attachments =
      att.doneAttachments.length > 0 ? att.doneAttachments : undefined;
    setText("");
    // This composer stays mounted after submit — clear so the next turn
    // starts fresh.
    att.clear();
    // S88: 剥出开头的 `@slug` —— slug 走 body 字段，剩下的才是问题本身。
    const [mentionAgentSlug, question] = splitMention(trimmed);
    streamBranch(targetNode.id, question, null, { attachments, mentionAgentSlug });
    onSubmitted?.();
    if (mobileCompact) setMobileExpanded(false);
  };

  if (isStreaming && targetNode) {
    return (
      <div
        data-mobile-composer
        data-composer-state="stopping"
        className="py-3 max-md:py-1"
      >
        <StopButton
          onClick={() => abortStream(targetNode.id)}
          disabled={isPending}
          className="w-full h-[44px] disabled:opacity-60"
          label={isPending ? "连接中…" : "停止生成（Esc）"}
          aria-label="停止生成"
          title={isPending ? "正在建立连接…" : "停止生成 (Esc)"}
        />
      </div>
    );
  }

  const compact = mobileCompact && !mobileExpanded;

  return (
    <div
      ref={rootRef}
      data-mobile-composer
      data-composer-state={compact ? "compact" : "expanded"}
      className={`relative ${compact ? "py-1" : "py-3 max-md:py-2"}`}
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
      {cmdNotice && (
        <div className="mb-1.5 text-label text-warn-ink">
          {cmdNotice}
        </div>
      )}
      {att.pending.length > 0 && (
        <div className="mb-2">
          <AttachmentPreview pending={att.pending} onRemove={att.remove} />
        </div>
      )}
      {att.notice && (
        <div className="mb-1.5 text-label text-warn-ink">
          {att.notice}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          data-composer-input
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (cmdNotice) setCmdNotice(null);
          }}
          onKeyDown={(e) => {
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
          disabled={!targetNode}
          placeholder={compact ? "追问…" : (placeholder ?? `继续对话…（${sendHint(sendKey)}，可粘贴图片 / 文件）`)}
          className={`min-w-0 flex-1 resize-none rounded-2xl border border-line-strong bg-surface text-body text-ink-strong outline-none focus:border-accent focus:ring-2 focus:ring-accent-line/50 placeholder:text-ink-faint transition-shadow shadow-raise disabled:opacity-50 ${
            compact
              ? "h-[44px] min-h-[44px] max-h-[44px] px-3 py-2.5"
              : "min-h-[44px] max-h-[160px] px-4 py-3 max-md:min-h-[72px]"
          }`}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={att.accept}
          multiple
          onChange={att.handlePicked}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!targetNode || att.atLimit}
          title={att.atLimit ? "已到附件上限" : "添加图片 / 文件"}
          className="shrink-0 h-[44px] w-[44px] rounded-2xl border border-line-strong bg-surface text-ink-muted flex items-center justify-center disabled:opacity-30 hover:text-ink hover:border-ink-faint active:scale-95 transition-all shadow-raise"
          aria-label="添加附件"
        >
          <span aria-hidden>📎</span>
        </button>
        {!compact && (
          <>
            <button
              type="button"
              onClick={() => setSketchOpen(true)}
              disabled={!targetNode || att.atLimit}
              title={att.atLimit ? "已到附件上限" : "画个草图（导出为图片附件）"}
              className="shrink-0 h-[44px] w-[44px] rounded-2xl border border-line-strong bg-surface text-ink-muted flex items-center justify-center disabled:opacity-30 hover:text-ink hover:border-ink-faint active:scale-95 transition-all shadow-raise"
              aria-label="画个草图"
            >
              <span aria-hidden>✏️</span>
            </button>
          </>
        )}
        {sketchOpen && (
          <SketchModal
            onClose={() => setSketchOpen(false)}
            onExport={(blob) => att.startUpload(blob, "sketch.png")}
          />
        )}
        <button
          onClick={submit}
          disabled={!text.trim() || !targetNode || att.hasUploading}
          title={att.hasUploading ? "等待附件上传…" : undefined}
          className="shrink-0 h-[44px] w-[44px] rounded-2xl bg-accent text-ink-inverse flex items-center justify-center disabled:opacity-30 hover:bg-accent-strong active:scale-95 transition-all shadow-raise"
          aria-label="发送"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
