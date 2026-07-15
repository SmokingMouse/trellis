"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ReferencePicker } from "./ReferencePicker";
import { ModePicker } from "./ModePicker";
import { SystemPromptPicker, FEYNMAN_PROMPT } from "./SystemPromptPicker";
import { ZoneEditor } from "./ZoneEditor";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { matchCommands, parseCommand, type Command, type CommandStore } from "@/lib/commands";
import { useSlashNav } from "@/hooks/useSlashNav";
import { AttachmentPreview } from "./AttachmentPreview";
import { Button } from "@/components/ui/Button";
import {
  useAttachmentUploads,
  MAX_ATTACHMENTS,
} from "@/hooks/useAttachmentUploads";

// B4: starter prompts shown on the empty first screen (chat mode) to lower
// the blank-canvas barrier — click fills the input. Mirrors GPT's suggestions.
const SUGGESTED_PROMPTS = [
  "用类比讲清楚 TCP 和 UDP 的区别",
  "帮我 review 一段代码的潜在 bug",
  "解释 React useEffect 的依赖数组",
  "把一段话润色得更专业",
];

// 费曼考官角色激活时的「讲解」起手式，替换默认的「提问」建议词，
// 避免在「你讲、AI 挑漏洞」语境下还提示用户去提问。
const FEYNMAN_STARTERS = [
  "我来讲讲 TCP 三次握手为什么是三次……",
  "我理解的 React 闭包陷阱是这样……",
  "我试着解释一下数据库索引为什么能加速查询……",
  "我来讲讲 HTTPS 是怎么保证安全的……",
];

// Keep the keyboard highlight visible inside the scrollable dropdown. Ref
// callbacks re-run per render, but scrollIntoView(nearest) on an already
// visible element is a no-op.
const scrollToActive = (el: HTMLButtonElement | null) => {
  el?.scrollIntoView({ block: "nearest" });
};
const suggestionRowClass = (isActive: boolean) =>
  `w-full text-left px-3 py-2 border-b last:border-b-0 border-line-faint ${
    isActive ? "bg-surface-muted" : "hover:bg-surface-muted"
  }`;

export function QuestionInput() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [skills, setSkills] = useState<{ name: string; description: string }[]>(
    [],
  );
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const draftMode = useSessionStore((s) => s.draftMode);
  const draftSystemPrompt = useSessionStore((s) => s.draftSystemPrompt);
  const draftWorkspacePath = useSessionStore((s) => s.draftWorkspacePath);
  // 费曼考官角色：输入框从「问问题」翻转成「讲解你的理解」。
  const isFeynman = draftSystemPrompt === FEYNMAN_PROMPT;
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  // C4: skill picker shows whenever the agent can run skills — workspace/
  // project always, plus chat with enhanced mode on (scratch workspace + full
  // tools). Plain chat (claude or codex) can't run skills.
  const skillCapable = draftMode !== "chat" || chatEnhanced;
  const sendKey = useSessionStore((s) => s.sendKey);
  const setSendKey = useSessionStore((s) => s.setSendKey);
  const historyDepth = useSessionStore((s) => s.historyDepth);
  const setHistoryDepth = useSessionStore((s) => s.setHistoryDepth);
  // C1: Trellis command palette. These store actions are dispatched locally
  // (never sent to the LLM) when the input is a bare /command.
  const session = useSessionStore((s) => s.session);
  const newConversation = useSessionStore((s) => s.newConversation);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const setProvider = useSessionStore((s) => s.setProvider);
  const provider = useSessionStore((s) => s.provider);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);
  // Transient note when a command no-ops (e.g. /clear with no session) or
  // /model echoes its usage. Cleared on the next keystroke.
  const [cmdNotice, setCmdNotice] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // C4: lazily load the skill list. Skills show in every mode — picking one
  // in pure chat auto-enables 增强模式 (see pickSkill), so the dropdown never
  // reads as "skills missing".
  useEffect(() => {
    if (skills.length) return;
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(d.skills ?? []))
      .catch(() => {});
  }, [skills.length]);

  // Stage 14: Workspace / Project draft modes need a workspace path
  // chosen before submit.
  const needsWorkspace = draftMode !== "chat" && !draftWorkspacePath;
  // Attachments: tool-capable modes take any whitelisted file (staged to
  // disk for the agent); pure chat is limited to images + inlineable text.
  const att = useAttachmentUploads(skillCapable ? "all" : "chat-safe");
  const { doneAttachments, hasUploading } = att;

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

  // C4: skill picker — active while the user types a leading "/name" token
  // (no space yet). Selecting fills "/name " so claude (which handles skills
  // natively) runs it when sent.
  const skillQuery =
    q.startsWith("/") && !q.includes(" ") ? q.slice(1).toLowerCase() : null;
  const matchedSkills =
    skillQuery !== null
      ? skills
          .filter((s) => s.name.toLowerCase().includes(skillQuery))
          .slice(0, 8)
      : [];
  // C1: Trellis commands match in *every* mode (first-class). They render
  // above skills in the shared "/" dropdown. matchCommands gates on the same
  // "/name" (no space) shape as skills, so the two lists co-exist cleanly.
  const matchedCommands = matchCommands(q);

  // Dropdown pick actions, shared by mouse click and keyboard (Enter/Tab).
  // /model takes an argument → fill "/model " for typing; other commands run
  // immediately; skills fill "/name " for claude to execute on send.
  const pickCommand = (c: Command) => {
    if (c.name === "model") {
      setQ(`/${c.name} `);
      ref.current?.focus();
      return;
    }
    const note = c.run(commandStore, "");
    if (note) {
      setCmdNotice(note);
      ref.current?.focus();
    } else {
      setQ("");
      setCmdNotice(null);
    }
  };
  const pickSkill = (name: string) => {
    // Pure chat spawns without tools — auto-enable 增强模式 so the picked
    // skill can actually run (the toggle chip above reflects it).
    if (!skillCapable) {
      setChatEnhanced(true);
      setCmdNotice("⚡ 已自动开启增强模式 — 技能需要工具（YOLO）");
    }
    setQ(`/${name} `);
    ref.current?.focus();
  };
  const slashNav = useSlashNav(
    matchedCommands.length + matchedSkills.length,
    q,
    (i) =>
      i < matchedCommands.length
        ? pickCommand(matchedCommands[i])
        : pickSkill(matchedSkills[i - matchedCommands.length].name),
  );

  const submit = async () => {
    const trimmed = q.trim();
    if (!trimmed) return;
    // C1: intercept bare Trellis commands BEFORE any send-to-LLM path. A bare
    // /command runs locally against the store and never streams. Skill
    // commands (/skill-name) aren't in the command registry, so parseCommand
    // returns null and they fall through to streamRoot → claude CLI as before.
    const parsed = parseCommand(trimmed);
    if (parsed) {
      const note = parsed.command.run(commandStore, parsed.args);
      if (note) {
        // No-op / usage echo: keep the input, surface the note inline.
        setCmdNotice(note);
      } else {
        // Command ran — clear the input so the palette resets.
        setQ("");
        setCmdNotice(null);
      }
      return;
    }
    if (busy || needsWorkspace || hasUploading) return;
    setBusy(true);
    // #5: always release busy when the stream settles. On success the
    // component unmounts first (`created` sets the session), so the reset is
    // invisible; on failure (server unreachable / non-2xx — surfaced via the
    // global StreamAlertToast) it un-bricks the composer so the user can
    // retry instead of being stuck on a disabled "提交中…" forever.
    streamRoot(trimmed, {
      attachments: doneAttachments.length > 0 ? doneAttachments : undefined,
    }).finally(() => setBusy(false));
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Suggestion navigation first — while the "/" dropdown is open, Enter
    // picks the highlighted item instead of sending.
    if (slashNav.handleKeyDown(e)) return;
    if (isSendCombo(e, sendKey)) {
      e.preventDefault();
      submit();
    }
  };

  const submitDisabled =
    !q.trim() || busy || needsWorkspace || hasUploading;
  const submitLabel = busy
    ? "提交中…"
    : needsWorkspace
      ? "先选工作区"
      : hasUploading
        ? "等待附件上传…"
        : "开始探索";

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6"
      // Wave 4: keep the composer centered within the editor area (right of
      // the explorer sidebar). var from page.tsx; 0 on mobile / collapsed.
      style={{ paddingLeft: "var(--trellis-sb, 0px)" }}
    >
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-8 justify-center">
          {/* 品牌渐变固定色（indigo → fuchsia → amber 原始 hex），不随主题换肤 */}
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-ink-muted mb-6 text-sm">
          想深入探索什么？任何问题都可以——后续可以选中回复里的任意文字继续追问。
        </p>
        <div className="mb-3 flex justify-center">
          <ModePicker />
        </div>
        {draftMode === "chat" && (
          <div className="mb-3 flex justify-center items-center gap-2 flex-wrap">
            <SystemPromptPicker />
            <button
              type="button"
              onClick={() => setChatEnhanced(!chatEnhanced)}
              title="增强模式：开启后 chat 能跑 skill + 联网（YOLO，无沙箱、能跑任意命令）。默认关 = 纯对话。"
              className={`px-3 py-1.5 rounded-full border text-ui inline-flex items-center gap-1.5 transition-colors ${
                chatEnhanced
                  ? /* boost 复用 warn hue */ "bg-warn-muted border-warn-line text-warn-ink"
                  : "border-line text-ink-muted hover:border-line-strong"
              }`}
            >
              <span aria-hidden>⚡</span>
              <span>增强模式{chatEnhanced ? " · 开" : ""}</span>
            </button>
          </div>
        )}
        <div
          className={`bg-surface border rounded-card shadow-raise overflow-hidden transition-colors ${
            dragOver
              ? "border-accent ring-2 ring-accent-line"
              : "border-line"
          }`}
          onDragOver={(e) => {
            // Only react to file drags (Files type), ignore text drags.
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false);
            att.handleDrop(e);
          }}
        >
          {att.pending.length > 0 && (
            <div className="px-4 pt-3">
              <AttachmentPreview
                pending={att.pending}
                onRemove={att.remove}
              />
            </div>
          )}
          <textarea
            ref={ref}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (cmdNotice) setCmdNotice(null);
            }}
            onKeyDown={onKey}
            onPaste={att.handlePaste}
            placeholder={
              isFeynman
                ? "讲讲你对某个概念的理解——AI 会复述、挑漏洞、追问你没讲清的地方。讲不清的点，选中它 ⌘K 开子节点继续深讲。"
                : "例如：Rust 的 ownership 系统在汇编层面是怎么实现的？粘贴图片 / 文件可加入提问。"
            }
            rows={4}
            className="w-full px-5 py-4 outline-none resize-none text-reading leading-relaxed bg-transparent text-ink-strong placeholder:text-ink-faint"
            disabled={busy}
          />
          <div className="border-t border-line-faint px-4 py-2 flex items-center justify-between gap-3">
            <div className="text-xs text-ink-faint flex-1 min-w-0">
              <button
                type="button"
                onClick={() =>
                  setSendKey(sendKey === "enter" ? "mod-enter" : "enter")
                }
                title="点击切换发送快捷键（Enter / ⌘Enter）"
                className="inline-flex items-center gap-1 hover:text-ink-muted transition-colors"
              >
                <span>{sendHint(sendKey)}</span>
                <span className="opacity-50" aria-hidden>
                  ⇄
                </span>
              </button>
              <span className="mx-1.5 text-ink-faint">·</span>
              <button
                type="button"
                onClick={() =>
                  setHistoryDepth(historyDepth >= 8 ? 0 : historyDepth + 2)
                }
                title="0 = B-fork 全发（历史存在会话里、缓存友好、不失忆，推荐）；≥1 = 窗口回退，只折叠 N 层历史进提示"
                className="inline-flex items-center gap-1 hover:text-ink-muted transition-colors"
              >
                <span aria-hidden>📚</span>
                <span>{historyDepth === 0 ? "上下文 全发" : `上下文 ${historyDepth} 层`}</span>
              </button>
            </div>
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
              onClick={() => setZoneOpen(true)}
              disabled={busy}
              title="进入专注写作模式（全屏 Markdown 编辑 + 预览）"
              className="text-xs text-ink-muted hover:text-ink-strong disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-muted"
            >
              <span aria-hidden>⛶</span>
              <span className="hidden sm:inline">专注写作</span>
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || att.atLimit}
              title={
                att.atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 个上限`
                  : "添加图片 / 文件（粘贴 / 拖拽 / 点击选）"
              }
              className="text-xs text-ink-muted hover:text-ink-strong disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-muted"
            >
              <span aria-hidden>📎</span>
              <span className="hidden sm:inline">附件</span>
            </button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={submitDisabled}
              title={
                needsWorkspace
                  ? `${draftMode === "workspace" ? "Workspace" : "Project"} 模式需要先选择工作区`
                  : undefined
              }
            >
              {submitLabel}
            </Button>
          </div>
        </div>
        {cmdNotice && (
          <div className="mt-2 text-ui text-warn-ink bg-warn-muted border border-warn-line rounded-lg px-3 py-2">
            {cmdNotice}
          </div>
        )}
        {att.notice && (
          <div className="mt-2 text-ui text-warn-ink bg-warn-muted border border-warn-line rounded-lg px-3 py-2">
            {att.notice}
          </div>
        )}
        {(matchedCommands.length > 0 || matchedSkills.length > 0) && (
          <div className="mt-2 border border-line rounded-lg bg-surface shadow-raise overflow-hidden max-h-64 overflow-y-auto">
            {/* C1: Trellis commands first (first-class, all modes). Selecting
                a no-arg command runs it immediately; /model (which takes an
                arg) fills "/model " so the user can type the provider.
                slashNav.active highlights in the same commands-then-skills
                index space. */}
            {matchedCommands.map((c, i) => (
              <button
                key={`cmd-${c.name}`}
                type="button"
                ref={i === slashNav.active ? scrollToActive : undefined}
                onClick={() => pickCommand(c)}
                className={suggestionRowClass(i === slashNav.active)}
              >
                <div className="text-ui font-mono text-ink flex items-center gap-1.5">
                  {/* ⚡徽章标识「Trellis 命令」身份（非告警）→ accent-muted */}
                  <span
                    className="text-nano px-1 py-0.5 rounded bg-accent-muted text-accent-ink font-sans"
                    aria-hidden
                  >
                    ⚡ 命令
                  </span>
                  <span>
                    /{c.name}
                    {c.hint && (
                      <span className="text-ink-faint">
                        {" "}
                        {c.hint}
                      </span>
                    )}
                  </span>
                </div>
                <div className="text-label text-ink-muted truncate">
                  {c.description}
                </div>
              </button>
            ))}
            {matchedSkills.map((s, i) => (
              <button
                key={`skill-${s.name}`}
                type="button"
                ref={
                  matchedCommands.length + i === slashNav.active
                    ? scrollToActive
                    : undefined
                }
                onClick={() => pickSkill(s.name)}
                className={suggestionRowClass(
                  matchedCommands.length + i === slashNav.active,
                )}
              >
                <div className="text-ui font-mono text-ink">
                  /{s.name}
                </div>
                {s.description && (
                  <div className="text-label text-ink-muted truncate">
                    {s.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
        {draftMode === "chat" && !q.trim() && (
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {(isFeynman ? FEYNMAN_STARTERS : SUGGESTED_PROMPTS).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQ(s);
                  ref.current?.focus();
                }}
                className="px-3 py-1.5 rounded-full border border-line bg-surface/60 text-ink-muted text-ui hover:border-line-strong hover:bg-surface transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-line" />
          <span className="text-ink-faint">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-line" />
        </div>
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-4 py-2 rounded-md text-sm border border-warn-line bg-warn-muted/60 text-warn-ink hover:bg-warn-muted active:scale-95 transition-colors flex items-center gap-2"
          >
            <span aria-hidden>📄</span>
            <span>从背景材料开始（粘贴 / URL）</span>
          </button>
        </div>
        <div className="text-center text-xs text-ink-faint mt-4">
          模型在右上角切换 · 默认 Claude Sonnet
        </div>
      </div>
      {pickerOpen && (
        <ReferencePicker onClose={() => setPickerOpen(false)} />
      )}
      {zoneOpen && (
        <ZoneEditor
          value={q}
          onChange={setQ}
          onSubmit={() => {
            if (submitDisabled) return;
            setZoneOpen(false);
            submit();
          }}
          onClose={() => setZoneOpen(false)}
          title={isFeynman ? "讲讲你的理解" : "专注写作"}
          placeholder={
            isFeynman
              ? "讲讲你对某个概念的理解——尽量讲透，AI 会复述、挑漏洞、追问。"
              : "在这里专注写下你的问题，支持 Markdown……"
          }
          submitLabel={submitLabel}
          submitDisabled={submitDisabled}
        />
      )}
    </div>
  );
}
