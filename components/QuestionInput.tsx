"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ReferencePicker } from "./ReferencePicker";
import { ModePicker } from "./ModePicker";
import { SystemPromptPicker, FEYNMAN_PROMPT } from "./SystemPromptPicker";
import { ZoneEditor } from "./ZoneEditor";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { matchCommands, parseCommand, type CommandStore } from "@/lib/commands";
import {
  AttachmentPreview,
  uploadAttachment,
  newPendingId,
  type PendingAttachment,
} from "./AttachmentPreview";
import type { NodeAttachment } from "@/lib/types";

const MAX_ATTACHMENTS = 6;

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

export function QuestionInput() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
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

  // C4: lazily load the skill list once the user is in a tool-capable mode.
  useEffect(() => {
    if (!skillCapable || skills.length) return;
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(d.skills ?? []))
      .catch(() => {});
  }, [skillCapable, skills.length]);

  // Stage 14: Workspace / Project draft modes need a workspace path
  // chosen before submit.
  const needsWorkspace = draftMode !== "chat" && !draftWorkspacePath;
  const hasUploading = pending.some((p) => p.status === "uploading");
  const doneAttachments: NodeAttachment[] = pending
    .filter((p): p is PendingAttachment & { attachment: NodeAttachment } =>
      p.status === "done" && !!p.attachment,
    )
    .map((p) => p.attachment);

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
    streamRoot(trimmed, {
      attachments: doneAttachments.length > 0 ? doneAttachments : undefined,
    });
  };

  const startUpload = (file: File | Blob, filename: string | null) => {
    if (pending.length >= MAX_ATTACHMENTS) return;
    if (!file.type.startsWith("image/")) return;
    const localId = newPendingId();
    const previewUrl = URL.createObjectURL(file);
    setPending((prev) => [
      ...prev,
      {
        localId,
        status: "uploading",
        previewUrl,
        filename,
      },
    ]);
    uploadAttachment(file, filename)
      .then((att) => {
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? { ...p, status: "done", attachment: att }
              : p,
          ),
        );
      })
      .catch((err) => {
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? {
                  ...p,
                  status: "error",
                  errorMessage: err instanceof Error ? err.message : String(err),
                }
              : p,
          ),
        );
      });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.type.startsWith("image/")) continue;
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      startUpload(file, null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      startUpload(files[i], files[i].name);
    }
  };

  const handlePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      startUpload(files[i], files[i].name);
    }
    // Allow re-picking the same file later.
    e.target.value = "";
  };

  const handleRemove = (localId: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendCombo(e, sendKey)) {
      e.preventDefault();
      submit();
    }
  };

  // C4: skill picker — active in workspace/project while the user types a
  // leading "/name" token (no space yet). Selecting fills "/name " so claude
  // (which handles skills natively) runs it when sent.
  const skillQuery =
    skillCapable && q.startsWith("/") && !q.includes(" ")
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

  const atLimit = pending.length >= MAX_ATTACHMENTS;
  const submitDisabled =
    !q.trim() || busy || needsWorkspace || hasUploading;
  const submitLabel = busy
    ? "提交中…"
    : needsWorkspace
      ? "先选工作区"
      : hasUploading
        ? "等待图片上传…"
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
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-stone-500 dark:text-stone-400 mb-6 text-sm">
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
              className={`px-3 py-1.5 rounded-full border text-[13px] inline-flex items-center gap-1.5 transition-colors ${
                chatEnhanced
                  ? "bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-200"
                  : "border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-500"
              }`}
            >
              <span aria-hidden>⚡</span>
              <span>增强模式{chatEnhanced ? " · 开" : ""}</span>
            </button>
          </div>
        )}
        <div
          className={`bg-white dark:bg-stone-900 border rounded-xl shadow-sm overflow-hidden transition-colors ${
            dragOver
              ? "border-indigo-400 dark:border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-900"
              : "border-stone-200 dark:border-stone-800"
          }`}
          onDragOver={(e) => {
            // Only react to file drags (Files type), ignore text drags.
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {pending.length > 0 && (
            <div className="px-4 pt-3">
              <AttachmentPreview
                pending={pending}
                onRemove={handleRemove}
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
            onPaste={handlePaste}
            placeholder={
              isFeynman
                ? "讲讲你对某个概念的理解——AI 会复述、挑漏洞、追问你没讲清的地方。讲不清的点，选中它 ⌘K 开子节点继续深讲。"
                : "例如：Rust 的 ownership 系统在汇编层面是怎么实现的？粘贴图片可加入提问。"
            }
            rows={4}
            className="w-full px-5 py-4 outline-none resize-none text-[15px] leading-relaxed bg-transparent text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500"
            disabled={busy}
          />
          <div className="border-t border-stone-100 dark:border-stone-800 px-4 py-2 flex items-center justify-between gap-3">
            <div className="text-xs text-stone-400 dark:text-stone-500 flex-1 min-w-0">
              <button
                type="button"
                onClick={() =>
                  setSendKey(sendKey === "enter" ? "mod-enter" : "enter")
                }
                title="点击切换发送快捷键（Enter / ⌘Enter）"
                className="inline-flex items-center gap-1 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
              >
                <span>{sendHint(sendKey)}</span>
                <span className="opacity-50" aria-hidden>
                  ⇄
                </span>
              </button>
              <span className="mx-1.5 text-stone-300 dark:text-stone-600">·</span>
              <button
                type="button"
                onClick={() =>
                  setHistoryDepth(historyDepth >= 8 ? 0 : historyDepth + 2)
                }
                title="0 = B-fork 全发（历史存在会话里、缓存友好、不失忆，推荐）；≥1 = 窗口回退，只折叠 N 层历史进提示"
                className="inline-flex items-center gap-1 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
              >
                <span aria-hidden>📚</span>
                <span>{historyDepth === 0 ? "上下文 全发" : `上下文 ${historyDepth} 层`}</span>
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={handlePicked}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => setZoneOpen(true)}
              disabled={busy}
              title="进入专注写作模式（全屏 Markdown 编辑 + 预览）"
              className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <span aria-hidden>⛶</span>
              <span className="hidden sm:inline">专注写作</span>
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || atLimit}
              title={
                atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 张上限`
                  : "添加图片（粘贴 / 拖拽 / 点击选）"
              }
              className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <span aria-hidden>🖼️</span>
              <span className="hidden sm:inline">图片</span>
            </button>
            <button
              onClick={submit}
              disabled={submitDisabled}
              title={
                needsWorkspace
                  ? `${draftMode === "workspace" ? "Workspace" : "Project"} 模式需要先选择工作区`
                  : undefined
              }
              className="bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-sm px-4 py-1.5 rounded-md hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitLabel}
            </button>
          </div>
        </div>
        {cmdNotice && (
          <div className="mt-2 text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
            {cmdNotice}
          </div>
        )}
        {(matchedCommands.length > 0 || matchedSkills.length > 0) && (
          <div className="mt-2 border border-stone-200 dark:border-stone-700 rounded-lg bg-white dark:bg-stone-900 shadow-sm overflow-hidden max-h-64 overflow-y-auto">
            {/* C1: Trellis commands first (first-class, all modes). Selecting
                a no-arg command runs it immediately; /model (which takes an
                arg) fills "/model " so the user can type the provider. */}
            {matchedCommands.map((c) => {
              const needsArg = c.name === "model";
              return (
                <button
                  key={`cmd-${c.name}`}
                  type="button"
                  onClick={() => {
                    if (needsArg) {
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
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 border-b last:border-b-0 border-stone-100 dark:border-stone-800"
                >
                  <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200 flex items-center gap-1.5">
                    <span
                      className="text-[10px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-sans"
                      aria-hidden
                    >
                      ⚡ 命令
                    </span>
                    <span>
                      /{c.name}
                      {c.hint && (
                        <span className="text-stone-400 dark:text-stone-500">
                          {" "}
                          {c.hint}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
                    {c.description}
                  </div>
                </button>
              );
            })}
            {matchedSkills.map((s) => (
              <button
                key={`skill-${s.name}`}
                type="button"
                onClick={() => {
                  setQ(`/${s.name} `);
                  ref.current?.focus();
                }}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 border-b last:border-b-0 border-stone-100 dark:border-stone-800"
              >
                <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
                  /{s.name}
                </div>
                {s.description && (
                  <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
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
                className="px-3 py-1.5 rounded-full border border-stone-200 dark:border-stone-700 bg-white/60 dark:bg-stone-900/60 text-stone-600 dark:text-stone-300 text-[13px] hover:border-stone-400 dark:hover:border-stone-500 hover:bg-white dark:hover:bg-stone-800 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
          <span className="text-stone-400 dark:text-stone-500">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
        </div>
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-4 py-2 rounded-md text-sm border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/60 active:scale-95 transition-colors flex items-center gap-2"
          >
            <span aria-hidden>📄</span>
            <span>从背景材料开始（粘贴 / URL）</span>
          </button>
        </div>
        <div className="text-center text-xs text-stone-400 dark:text-stone-500 mt-4">
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
