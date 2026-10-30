"use client";
import { useState, useRef, useEffect, useImperativeHandle, type Ref } from "react";
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
import { SkillPickerList } from "./SkillPickerList";
import { NodeRefChips } from "./NodeRefChips";
import { refFromItem, useNodeRefMentions, type RefPickItem } from "@/hooks/useNodeRefMentions";
import { appendNodeRefs, MAX_NODE_REFS, removeMentionQuery, type NodeRef } from "@/lib/node-refs";
import { ModelPicker } from "./ModelPicker";
import { COMPOSER_TOOL_ICON } from "./ComposerShell";
import {
  ArrowLeftRight,
  ArrowUp,
  FileText,
  History,
  Maximize2,
  Paperclip,
  PencilLine,
  Plus,
  X,
  Zap,
} from "lucide-react";
import { Button, Drawer, Icon, IconButton, Tooltip, cn } from "@/components/ui";
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

const ENHANCED_HINT =
  "增强模式：chat 可跑 skill + 联网，工具调用自动批准（无沙箱、能跑任意命令）。默认关 = 纯对话。";

/** 首页用：从外部把文字填进输入框（快捷提示卡），或把焦点送回来。不发送。 */
export type QuestionInputHandle = {
  fill: (text: string) => void;
  focus: () => void;
};

export function QuestionInput({
  isMobile,
  variant = "screen",
  autoFocus = true,
  controlRef,
  butler = false,
}: {
  isMobile: boolean;
  /** 管家草稿：mode / agent / 增强档都由管家钉死，藏掉这几个选择器免得误导 */
  butler?: boolean;
  /** screen = 独占的新会话首屏（原样）；home = 嵌进首页，去掉品牌头、起步词和底部入口 */
  variant?: "screen" | "home";
  autoFocus?: boolean;
  controlRef?: Ref<QuestionInputHandle>;
}) {
  const embedded = variant === "home";
  const [q, setQ] = useState("");
  // `@` 引用其他会话 / 节点作为上下文（lib/node-refs.ts）：新会话首问就能带上别处的结论。
  const [refs, setRefs] = useState<NodeRef[]>([]);
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
  const setDraftWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
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
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // 桌面输入框随内容长高（2 行起，CSS max-h 封顶后内部滚动）；手机保持固定 4 行。
  useEffect(() => {
    const el = ref.current;
    if (!el || isMobile) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [q, isMobile]);

  useImperativeHandle(controlRef, () => ({
    fill: (text: string) => {
      setQ(text);
      setCmdNotice(null);
      ref.current?.focus();
    },
    focus: () => ref.current?.focus(),
  }), []);

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

  // Project 模式没选工作区不再拦发送：发送时自动建一个空白沙箱
  // （~/.trellis/scratch/ 下），学习问答不用先挑目录。
  const needsWorkspace = false;
  const autoSandbox = !butler && draftMode !== "chat" && !draftWorkspacePath;
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
  const nodeRefs = useNodeRefMentions(
    q,
    matchedCommands.length === 0 && matchedSkills.length === 0 && refs.length < MAX_NODE_REFS,
  );
  const refItems = nodeRefs.items;
  const pickRef = (item: RefPickItem) => {
    const picked = refFromItem(item);
    if (!picked) return nodeRefs.toggleExpand(item.session.sessionId);
    setRefs((cur) =>
      cur.some((r) => r.nodeId === picked.nodeId) ? cur : [...cur, picked].slice(0, MAX_NODE_REFS),
    );
    setQ((cur) => removeMentionQuery(cur));
    nodeRefs.collapse();
    ref.current?.focus();
  };

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
      setCmdNotice("已自动开启增强模式——技能需要工具（自动批准，本轮起生效）");
    }
    setQ(`${skillPrefix}${name} `);
    ref.current?.focus();
  };
  // `@` 引用的会话行与 `/` 命令 / 技能互斥（见上方 nodeRefs 的 enabled），索引从 0 起。
  const slashNav = useSlashNav(
    matchedCommands.length + matchedSkills.length + refItems.length,
    q,
    (i) =>
      refItems.length > 0
        ? pickRef(refItems[i])
        : i < matchedCommands.length
          ? pickCommand(matchedCommands[i])
          : pickSkill(matchedSkills[i - matchedCommands.length].name),
  );

  const submit = async () => {
    const trimmed = q.trim();
    if (!trimmed && refs.length === 0) return;
    // C1: intercept bare Trellis commands BEFORE any send-to-LLM path. A bare
    // /command runs locally against the store and never streams. Skill
    // commands (/skill-name) aren't in the command registry, so parseCommand
    // returns null and they fall through to streamRoot → claude CLI as before.
    const parsed = refs.length === 0 ? parseCommand(trimmed) : null;
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
    if (autoSandbox) {
      try {
        const res = await fetch("/api/workspaces/scratch", { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!res.ok || !body.path) throw new Error(body.error ?? `HTTP ${res.status}`);
        setDraftWorkspacePath(body.path);
      } catch (err) {
        setBusy(false);
        setCmdNotice(`建空白沙箱失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    // #5: always release busy when the stream settles. On success the
    // component unmounts first (`created` sets the session), so the reset is
    // invisible; on failure (server unreachable / non-2xx — surfaced via the
    // global StreamAlertToast) it un-bricks the composer so the user can
    // retry instead of being stuck on a disabled "提交中…" forever.
    streamRoot(appendNodeRefs(trimmed, refs), {
      attachments: doneAttachments.length > 0 ? doneAttachments : undefined,
    }).finally(() => setBusy(false));
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字中的 Enter 是选词，不是发送 / 选中补全项。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Suggestion navigation first — while the "/" dropdown is open, Enter
    // picks the highlighted item instead of sending.
    if (slashNav.handleKeyDown(e)) return;
    if (isSendCombo(e, sendKey)) {
      e.preventDefault();
      submit();
    }
  };

  const submitDisabled =
    (!q.trim() && refs.length === 0) || busy || needsWorkspace || hasUploading;
  const submitLabel = busy
    ? "提交中…"
    : needsWorkspace
      ? "先选工作区"
      : hasUploading
        ? "等待附件上传…"
        : butler
          ? "发给管家"
          : "开始探索";

  return (
    <div
      data-question-input={variant}
      className={embedded ? "w-full flex flex-col items-center" : "min-h-dvh flex flex-col items-center justify-center px-6"}
      // Wave 4: keep the composer centered within the editor area (right of
      // the explorer sidebar). var from page.tsx; 0 on mobile / collapsed.
      style={embedded ? undefined : { paddingLeft: "var(--trellis-sb, 0px)" }}
    >
      <div className={embedded ? "w-full max-w-2xl md:max-w-none" : "w-full max-w-2xl"}>
        {!embedded && <>
        <div className="flex items-center gap-3 mb-8 max-md:mb-3 justify-center">
          {/* 品牌渐变固定色（indigo → fuchsia → amber 原始 hex），不随主题换肤 */}
          {/* ui-guard-allow(hex): 品牌渐变 logo（不随皮肤，刻意裁决） */}
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-ink-muted mb-6 max-md:mb-3 text-sm">
          想深入探索什么？任何问题都可以——后续可以选中回复里的任意文字继续追问。
        </p>
        </>}
        {/* 桌面：模式 / Agent / 增强模式 / 模型都在输入框底栏（原型 .c-bar）；手机仍是一行摘要 + 「更多设置」sheet。
            S89: Agent 选择两个 mode 都出现（服务端 chat/route.ts 对 agentId 的钳制只看「claude 家族」、
            不看 mode）。增强模式是 chat 专属。 */}
        {!butler && isMobile && (
          <button
            type="button"
            data-mobile-target="new-session-config-summary"
            onClick={() => setMoreSettingsOpen(true)}
            className="press-row mb-3 w-full min-h-11 min-w-0 rounded-card bg-surface-raised px-3 text-left text-ui text-ink-muted shadow-btn flex items-center gap-2"
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
        )}
        <div
          // bui composer：浮起的 window 卡（真描边 + raise 阴影），聚焦时描边加深 + 4px accent 淡光晕。
          className={`bg-surface border rounded-window shadow-raise transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-line-strong focus-within:ring-4 focus-within:ring-focus-ring/40 max-md:rounded-[22px] ${
            // 桌面底栏里的 Agent 下拉是卡内绝对定位的，不能裁；手机保持原样
            isMobile ? "overflow-hidden" : ""
          } ${
            dragOver
              ? "border-accent ring-4 ring-accent-line"
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
          {refs.length > 0 && (
            <div className="px-4 pt-3">
              <NodeRefChips refs={refs} onRemove={(id) => setRefs((cur) => cur.filter((r) => r.nodeId !== id))} />
            </div>
          )}
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
              butler
                ? "比如：每天 9 点跑一次仓库日报；给写作 Agent 加上 web-fetch 技能"
                : isFeynman
                ? "讲讲你对某个概念的理解——AI 会复述、挑漏洞、追问你没讲清的地方。讲不清的点，选中它 ⌘K 开子节点继续深讲。"
                : "例如：Rust 的 ownership 系统在汇编层面是怎么实现的？粘贴图片 / 文件可加入提问。"
            }
            // 桌面：原型 .composer textarea——2 行起（padding 16/16/6，min 80px 让卡片落在 ~126px 不显挤），随内容长高到 200px；手机保持 4 行
            rows={isMobile ? 4 : 2}
            // 焦点环画在外层卡片上（focus-within）；全局 :focus-visible 压不住，内联去掉输入框自己那一圈。
            style={{ outline: "none" }}
            className="block w-full px-4 pt-3.5 pb-1.5 md:pt-4 outline-none resize-none text-reading leading-relaxed bg-transparent text-ink-strong placeholder:text-ink-faint md:text-[14.5px] md:leading-[1.55] md:min-h-20 md:max-h-50"
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
            <div className="px-2 pb-2 pt-1.5 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                data-mobile-target="new-session-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || att.atLimit}
                title={
                  att.atLimit
                    ? `已到 ${MAX_ATTACHMENTS} 个上限`
                    : "添加图片 / 文件（粘贴 / 拖拽 / 点击选）"
                }
                className="h-11 rounded-full!"
              >
                <Icon icon={Paperclip} />
                附件
              </Button>
              <Button
                variant="ink"
                data-mobile-target="new-session-start"
                className="h-11 flex-1 rounded-full!"
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
          // 原型 .c-bar：[+][模式 ⌄][Agent ⌄][增强][草图][专注写作] … [模型 ⌄][发送 ●]。
          // 左侧只留文字胶囊给模式 / Agent，其余一律 28px 圆形图标钮（文案进 tooltip / aria-label）；
          // 桌面不折行：挤的时候让 ModelPicker（min-w-0 wrapper）先截断，而不是整颗掉到第二行。
          <div className="px-2 pb-2 pt-1.5 flex flex-wrap md:flex-nowrap items-center gap-1" data-question-input-toolbar="">
            <IconButton
              label="添加附件"
              title={
                att.atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 个上限`
                  : "添加图片 / 文件（粘贴 / 拖拽 / 点击选）"
              }
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || att.atLimit}
              className={COMPOSER_TOOL_ICON}
            >
              <Icon icon={Plus} />
            </IconButton>
            {!butler && (
              <div data-composer-context="" className="flex min-w-0 shrink-0 flex-wrap md:flex-nowrap items-center gap-1">
                <ModePicker variant="toolbar" />
                <AgentPicker variant="toolbar" />
                {draftMode === "chat" && (
                  <IconButton
                    label="增强模式"
                    title={`${chatEnhanced ? "增强模式 · 开" : "增强模式 · 关"}｜${ENHANCED_HINT}`}
                    aria-pressed={chatEnhanced}
                    onClick={() => setChatEnhanced(!chatEnhanced)}
                    className={cn(
                      COMPOSER_TOOL_ICON,
                      chatEnhanced && "bg-accent-muted text-accent-ink ring-1 ring-inset ring-accent-line hover:bg-accent-muted hover:text-accent-ink",
                    )}
                  >
                    <Icon icon={Zap} selected={chatEnhanced} />
                  </IconButton>
                )}
              </div>
            )}
            <IconButton
              label="画个草图"
              title={
                att.atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 个上限`
                  : "画个草图（导出为图片附件）"
              }
              onClick={() => setSketchOpen(true)}
              disabled={busy || att.atLimit}
              className={COMPOSER_TOOL_ICON}
            >
              <Icon icon={PencilLine} />
            </IconButton>
            <IconButton
              label="专注写作"
              title="专注写作（全屏 Markdown 编辑 + 预览）"
              onClick={() => setZoneOpen(true)}
              disabled={busy}
              className={COMPOSER_TOOL_ICON}
            >
              <Icon icon={Maximize2} />
            </IconButton>
            <span className="min-w-2 flex-1" />
            <ModelPicker compact />
            <Tooltip content={needsWorkspace ? "Project 模式需要先选择工作区" : submitLabel}>
              <button
                type="button"
                // bui .send：30px 墨色圆钮 + 上箭头；文案（开始探索 / 先选工作区…）进 aria-label + tooltip
                aria-label={submitLabel}
                data-question-input-submit=""
                onClick={submit}
                disabled={submitDisabled}
                className="press ml-0.5 grid size-7.5 shrink-0 place-items-center rounded-full bg-ink text-ink-inverse shadow-primary transition-[background-color,opacity] duration-150 hover:bg-ink/88 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-ink"
              >
                <Icon icon={ArrowUp} size="sm" />
              </button>
            </Tooltip>
          </div>
          )}
        </div>
        {!isMobile && (
          // bui c-hint：卡片下方一行 11.5px 弱化提示（发送键切换 · 上下文层数）
          <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-[11.5px] leading-4 text-ink-faint tabular-nums">
            <button
              type="button"
              onClick={() =>
                setSendKey(sendKey === "enter" ? "mod-enter" : "enter")
              }
              title="点击切换发送快捷键（Enter / ⌘Enter）"
              className="inline-flex min-w-0 items-center gap-1 rounded-chip transition-colors duration-100 hover:text-ink-muted"
            >
              <span>{sendHint(sendKey)}</span>
              <Icon icon={ArrowLeftRight} size="sm" className="opacity-60" />
            </button>
            <button
              type="button"
              onClick={() =>
                setHistoryDepth(historyDepth >= 8 ? 0 : historyDepth + 2)
              }
              title="0 = 全发（历史存在 CLI 会话里、缓存友好、不失忆，推荐；claude 走 --fork-session，codex 走 resume+前缀 rollout）；≥1 = 窗口回退，只折叠 N 层历史进提示"
              className="inline-flex min-w-0 items-center gap-1 rounded-chip transition-colors duration-100 hover:text-ink-muted"
            >
              <Icon icon={History} size="sm" />
              <span>{historyDepth === 0 ? "上下文 全发" : `上下文 ${historyDepth} 层`}</span>
            </button>
          </div>
        )}
        {isMobile && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-mobile-target="new-session-more-settings"
              onClick={() => setMoreSettingsOpen(true)}
              className="press-row min-h-11 flex-1 rounded-card bg-surface-raised text-ui text-ink-muted shadow-btn"
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
          <div className="mt-2 text-ui text-ink-muted bg-surface-raised shadow-btn rounded-card px-3 py-2">
            {cmdNotice}
          </div>
        )}
        {att.notice && (
          <div className="mt-2 text-ui text-warn-ink bg-warn-muted border border-warn-line rounded-card px-3 py-2">
            {att.notice}
          </div>
        )}
        {/* 体验 A：草稿相似检测。放在通知条之下、"/"下拉之上不冲突 ——
            "/"开头的输入 RelatedHints 自身会跳过。 */}
        <RelatedHints query={q} />
        <SkillPickerList
          placement="inline"
          skills={matchedSkills}
          onPick={pickSkill}
          commands={matchedCommands}
          onPickCommand={pickCommand}
          refItems={refItems}
          onPickRef={pickRef}
          refExpandedId={nodeRefs.expandedId}
          refExpandedLoading={nodeRefs.expandedLoading}
          onToggleRefExpand={nodeRefs.toggleExpand}
          activeIndex={slashNav.active}
          skillPrefix={skillPrefix}
        />
        {!embedded && isMobile === false && draftMode === "chat" && !q.trim() && (
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {(isFeynman ? FEYNMAN_STARTERS : SUGGESTED_PROMPTS).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQ(s);
                  ref.current?.focus();
                }}
                className="press px-3 py-1.5 rounded-full bg-surface-raised text-ink-muted text-ui shadow-btn transition-colors duration-100 hover:bg-surface-hover hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {!embedded && isMobile === false && <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-line" />
          <span className="text-ink-faint">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-line" />
        </div>}
        {!embedded && isMobile === false && <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => setPickerOpen(true)}>
            <Icon icon={FileText} size="sm" className="text-ink-faint" />
            从背景材料开始（粘贴 / URL）
          </Button>
        </div>}
        {!embedded && isMobile === false && <div className="text-center text-xs text-ink-faint mt-4">
          模型在输入框右下角切换 · {currentProvider ? `默认 ${currentProvider.shortLabel}` : "使用当前默认模型"}
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
              <Icon icon={X} />
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
                aria-pressed={chatEnhanced}
                title={ENHANCED_HINT}
                className={`w-full min-h-11 px-3 rounded-field border text-ui inline-flex items-center justify-center gap-1.5 transition-colors ${
                  chatEnhanced
                    ? "bg-accent-muted border-accent-line text-accent-ink"
                    : "border-line text-ink-muted hover:bg-surface-hover"
                }`}
              >
                <Icon icon={Zap} size="sm" selected={chatEnhanced} />
                <span>增强模式{chatEnhanced ? " · 开" : ""}（工具调用自动批准）</span>
              </button>
            )}
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                data-mobile-target="new-session-send-key"
                onClick={() => setSendKey(sendKey === "enter" ? "mod-enter" : "enter")}
                className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted"
              >
                快捷键 · {sendHint(sendKey)}
              </button>
              <button
                type="button"
                data-mobile-target="new-session-history-depth"
                onClick={() => setHistoryDepth(historyDepth >= 8 ? 0 : historyDepth + 2)}
                className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted"
              >
                历史深度 · {historyDepth === 0 ? "上下文全发" : `${historyDepth} 层`}
              </button>
              <button
                type="button"
                data-mobile-target="new-session-focus-writing"
                onClick={() => setZoneOpen(true)}
                disabled={busy}
                className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted disabled:opacity-40 inline-flex items-center gap-2"
              >
                <Icon icon={Maximize2} size="sm" />
                专注写作
              </button>
              <button
                type="button"
                data-mobile-target="new-session-sketch"
                onClick={() => setSketchOpen(true)}
                disabled={busy || att.atLimit}
                className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted disabled:opacity-40 inline-flex items-center gap-2"
              >
                <Icon icon={PencilLine} size="sm" />
                草图
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
                    className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted"
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
                  className="min-h-11 rounded-field border border-line px-3 text-left text-ui text-ink-muted inline-flex items-center gap-2"
                >
                  <Icon icon={FileText} size="sm" />
                  从背景材料开始（粘贴 / URL）
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
