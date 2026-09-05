"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ReferencePicker } from "./ReferencePicker";
import { ModePicker } from "./ModePicker";
import { AgentPicker } from "./AgentPicker";
import { FEYNMAN_PROMPT } from "@/lib/agent-presets";
import { ZoneEditor } from "./ZoneEditor";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { matchCommands, parseCommand, type Command, type CommandStore } from "@/lib/commands";
import { useSlashNav } from "@/hooks/useSlashNav";
import { providerFamily } from "@/lib/llm";
import { AttachmentPreview } from "./AttachmentPreview";
import { RelatedHints } from "./RelatedHints";
import { SketchModal } from "./SketchModal";
import { ModelPicker } from "./ModelPicker";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { setDesktopModeOverride } from "@/hooks/useIsMobile";
import { middleEllipsisPath } from "@/lib/run-config";
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

export function QuestionInput({ isMobile }: { isMobile: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
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
  const draftAgentId = useSessionStore((s) => s.draftAgentId);
  // 费曼考官角色：输入框从「问问题」翻转成「讲解你的理解」。
  // S88 后费曼有两种来源：内置 agent（builtin-feynman）或存量的裸 systemPrompt。
  const isFeynman =
    draftAgentId === "builtin-feynman" || draftSystemPrompt === FEYNMAN_PROMPT;
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  // C4: skill picker shows whenever the agent can run skills — project
  // always, plus chat with enhanced mode on (scratch workspace + full
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
  const family = providerFamily(provider);
  const skillProvider = family === "codex" ? "codex" : "claude";
  const skillPrefix = family === "codex" ? "$" : "/";
  const providerCatalog = useSessionStore((s) => s.providerCatalog);
  const currentProvider =
    providerCatalog.find((candidate) => candidate.id === provider) ??
    providerCatalog[0];
  const modeSummary = draftMode === "chat" ? "Chat" : "Project";
  const modelSummary = currentProvider?.shortLabel ?? provider;
  const workspaceSummary = draftWorkspacePath
    ? middleEllipsisPath(draftWorkspacePath)
    : "未选工作区";
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
    if (family === "mock") return;
    let alive = true;
    const params = new URLSearchParams({ provider: skillProvider });
    if (draftWorkspacePath) params.set("workspace", draftWorkspacePath);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSkills(d.skills ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [draftWorkspacePath, family, skillProvider]);

  // Stage 14: the Project draft mode needs a workspace path chosen
  // before submit.
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

  // Accept either marker for discovery; selection normalizes to the active
  // CLI's native invocation (`/name` for Claude, `$name` for Codex).
  const skillMarker = q.startsWith("$") ? "$" : q.startsWith("/") ? "/" : null;
  const skillQuery =
    family !== "mock" && skillMarker && !q.includes(" ")
      ? q.slice(1).toLowerCase()
      : null;
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
    setQ(`${skillPrefix}${name} `);
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
      className="min-h-dvh flex flex-col items-center justify-center px-6"
      // Wave 4: keep the composer centered within the editor area (right of
      // the explorer sidebar). var from page.tsx; 0 on mobile / collapsed.
      style={{ paddingLeft: "var(--trellis-sb, 0px)" }}
    >
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-8 max-md:mb-3 justify-center">
          {/* 品牌渐变固定色（indigo → fuchsia → amber 原始 hex），不随主题换肤 */}
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-ink-muted mb-6 max-md:mb-3 text-sm">
          想深入探索什么？任何问题都可以——后续可以选中回复里的任意文字继续追问。
        </p>
        {isMobile ? (
          <button
            type="button"
            data-mobile-target="new-session-config-summary"
            onClick={() => setMoreSettingsOpen(true)}
            className="mb-3 w-full min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-left text-ui text-ink-muted flex items-center gap-2 hover:border-line-strong"
            title={`${modeSummary} · ${modelSummary}${draftMode === "project" ? ` · ${draftWorkspacePath ?? "未选工作区"}` : ""}`}
          >
            <span className="shrink-0 font-medium text-ink">{modeSummary}</span>
            <span aria-hidden className="text-ink-faint">·</span>
            <span className="min-w-0 truncate">{modelSummary}</span>
            {draftMode === "project" && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span className="min-w-0 flex-1 truncate font-mono text-label">
                  {workspaceSummary}
                </span>
              </>
            )}
            <span className="ml-auto shrink-0 text-accent-ink">设置 ›</span>
          </button>
        ) : (
          <div className="mb-3 flex justify-center">
            <ModePicker />
          </div>
        )}
        {/* S89: Agent 选择两个 mode 都出现。原来整块被 `draftMode === "chat"` 关着，
            但服务端 chat/route.ts 对 agentId 的钳制条件只有「claude 家族」、**不看 mode**
            —— 即 project 会话完全支持 agent，只是界面上没有入口，只能靠 @提及。
            AgentPicker 内部仍然只在 chat 时露出自定义 system prompt 的 textarea
            （project 的人设来自 CLAUDE.md，服务端会把 systemPrompt 钳成 null）。
            增强模式是 chat 专属，留在下面的条件块里。 */}
        {isMobile === false && (
          <div className="mb-3 flex justify-center items-center gap-2 flex-wrap">
            <AgentPicker />
            {draftMode === "chat" && (
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
            )}
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
            data-mobile-target="new-session-input"
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
          <input
            ref={fileInputRef}
            type="file"
            accept={att.accept}
            multiple
            onChange={att.handlePicked}
            className="hidden"
          />
          {isMobile ? (
            <div className="border-t border-line-faint px-3 py-2 flex items-center justify-between gap-2">
              <button
                type="button"
                data-mobile-target="new-session-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || att.atLimit}
                title={
                  att.atLimit
                    ? `已到 ${MAX_ATTACHMENTS} 个上限`
                    : "添加图片 / 文件（粘贴 / 拖拽 / 点击选）"
                }
                className="h-11 min-w-11 px-3 rounded-md text-sm text-ink-muted hover:text-ink-strong hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
              >
                <span aria-hidden>📎</span>
                <span>附件</span>
              </button>
              <Button
                variant="primary"
                data-mobile-target="new-session-start"
                className="h-11 flex-1"
                onClick={submit}
                disabled={submitDisabled}
                title={
                  needsWorkspace ? "Project 模式需要先选择工作区" : undefined
                }
              >
                {submitLabel}
              </Button>
            </div>
          ) : (
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
                title="0 = 全发（历史存在 CLI 会话里、缓存友好、不失忆，推荐；claude 走 --fork-session，codex 走 resume+前缀 rollout）；≥1 = 窗口回退，只折叠 N 层历史进提示"
                className="inline-flex items-center gap-1 hover:text-ink-muted transition-colors"
              >
                <span aria-hidden>📚</span>
                <span>{historyDepth === 0 ? "上下文 全发" : `上下文 ${historyDepth} 层`}</span>
              </button>
            </div>
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
            <button
              type="button"
              onClick={() => setSketchOpen(true)}
              disabled={busy || att.atLimit}
              title={
                att.atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 个上限`
                  : "画个草图（导出为图片附件）"
              }
              className="text-xs text-ink-muted hover:text-ink-strong disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-muted"
            >
              <span aria-hidden>✏️</span>
              <span className="hidden sm:inline">草图</span>
            </button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={submitDisabled}
              title={
                needsWorkspace ? "Project 模式需要先选择工作区" : undefined
              }
            >
              {submitLabel}
            </Button>
          </div>
          )}
        </div>
        {isMobile && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-mobile-target="new-session-more-settings"
              onClick={() => setMoreSettingsOpen(true)}
              className="min-h-11 flex-1 rounded-md border border-line bg-surface text-ui text-ink-muted hover:border-line-strong hover:text-ink"
            >
              更多设置
            </button>
            <button
              type="button"
              data-mobile-target="new-session-desktop-mode"
              onClick={() => {
                setDesktopModeOverride(true);
                window.location.reload();
              }}
              className="min-h-11 px-3 text-ui text-accent-ink underline underline-offset-2"
            >
              转桌面版
            </button>
          </div>
        )}
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
        {/* 体验 A：草稿相似检测。放在通知条之下、"/"下拉之上不冲突 ——
            "/"开头的输入 RelatedHints 自身会跳过。 */}
        <RelatedHints query={q} />
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
                  {skillPrefix}{s.name}
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
        {isMobile === false && draftMode === "chat" && !q.trim() && (
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
        {isMobile === false && <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-line" />
          <span className="text-ink-faint">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-line" />
        </div>}
        {isMobile === false && <div className="mt-3 flex justify-center">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-4 py-2 rounded-md text-sm border border-warn-line bg-warn-muted/60 text-warn-ink hover:bg-warn-muted active:scale-95 transition-colors flex items-center gap-2"
          >
            <span aria-hidden>📄</span>
            <span>从背景材料开始（粘贴 / URL）</span>
          </button>
        </div>}
        {isMobile === false && <div className="text-center text-xs text-ink-faint mt-4">
          模型在右上角切换 · 默认 Claude Sonnet
        </div>}
      </div>
      {isMobile && moreSettingsOpen && (
        <Drawer open onClose={() => setMoreSettingsOpen(false)}>
          <div className="shrink-0 px-4 py-2 border-b border-line-faint flex items-center justify-between">
            <div>
              <div className="text-reading font-semibold text-ink-strong">更多设置</div>
              <div className="text-label text-ink-faint">创建前可调整，当前默认值已保留</div>
            </div>
            <IconButton label="关闭更多设置" onClick={() => setMoreSettingsOpen(false)}>
              ✕
            </IconButton>
          </div>
          <div
            data-mobile-target="new-session-settings-sheet"
            className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"
          >
            <section>
              <h2 className="text-label font-medium text-ink-faint mb-2">模式与工作区</h2>
              <ModePicker />
            </section>
            <section>
              <h2 className="text-label font-medium text-ink-faint mb-2">模型</h2>
              <ModelPicker />
            </section>
            <section>
              <h2 className="text-label font-medium text-ink-faint mb-2">Agent</h2>
              <div className="flex justify-center">
                <AgentPicker />
              </div>
            </section>
            {draftMode === "chat" && (
              <button
                type="button"
                data-mobile-target="new-session-enhanced"
                onClick={() => setChatEnhanced(!chatEnhanced)}
                title="增强模式：开启后 chat 能跑 skill + 联网（YOLO，无沙箱、能跑任意命令）。默认关 = 纯对话。"
                className={`w-full min-h-11 px-3 rounded-md border text-ui inline-flex items-center justify-center gap-1.5 transition-colors ${
                  chatEnhanced
                    ? "bg-warn-muted border-warn-line text-warn-ink"
                    : "border-line text-ink-muted hover:border-line-strong"
                }`}
              >
                <span aria-hidden>⚡</span>
                <span>增强模式{chatEnhanced ? " · 开" : ""}</span>
              </button>
            )}
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                data-mobile-target="new-session-send-key"
                onClick={() => setSendKey(sendKey === "enter" ? "mod-enter" : "enter")}
                className="min-h-11 rounded-md border border-line px-3 text-left text-ui text-ink-muted"
              >
                快捷键 · {sendHint(sendKey)}
              </button>
              <button
                type="button"
                data-mobile-target="new-session-history-depth"
                onClick={() => setHistoryDepth(historyDepth >= 8 ? 0 : historyDepth + 2)}
                className="min-h-11 rounded-md border border-line px-3 text-left text-ui text-ink-muted"
              >
                历史深度 · {historyDepth === 0 ? "上下文全发" : `${historyDepth} 层`}
              </button>
              <button
                type="button"
                data-mobile-target="new-session-focus-writing"
                onClick={() => setZoneOpen(true)}
                disabled={busy}
                className="min-h-11 rounded-md border border-line px-3 text-left text-ui text-ink-muted disabled:opacity-40"
              >
                ⛶ 专注写作
              </button>
              <button
                type="button"
                data-mobile-target="new-session-sketch"
                onClick={() => setSketchOpen(true)}
                disabled={busy || att.atLimit}
                className="min-h-11 rounded-md border border-line px-3 text-left text-ui text-ink-muted disabled:opacity-40"
              >
                ✏️ 草图
              </button>
            </div>
            <section>
              <h2 className="text-label font-medium text-ink-faint mb-2">起步模板</h2>
              <div className="flex flex-col gap-2">
                {(isFeynman ? FEYNMAN_STARTERS : SUGGESTED_PROMPTS).map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => {
                      setQ(starter);
                      setMoreSettingsOpen(false);
                      ref.current?.focus();
                    }}
                    className="min-h-11 rounded-md border border-line px-3 text-left text-ui text-ink-muted"
                  >
                    {starter}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setMoreSettingsOpen(false);
                    setPickerOpen(true);
                  }}
                  className="min-h-11 rounded-md border border-warn-line bg-warn-muted/60 px-3 text-left text-ui text-warn-ink"
                >
                  📄 从背景材料开始（粘贴 / URL）
                </button>
              </div>
            </section>
          </div>
        </Drawer>
      )}
      {pickerOpen && (
        <ReferencePicker onClose={() => setPickerOpen(false)} />
      )}
      {sketchOpen && (
        <SketchModal
          onClose={() => setSketchOpen(false)}
          onExport={(blob) => att.startUpload(blob, "sketch.png")}
        />
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
