"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "@/components/ui/Button";

// D1: pick the AI persona (system prompt) for the next new chat session.
// Chat-mode only — project derive their persona from CLAUDE.md.
// Locked into the session row on creation, like mode/workspace.
type Preset = { label: string; prompt: string | null; hint: string };

// 费曼学习法：反转信息流——你讲解、AI 当考官，逼出你理解里的漏洞。
// 导出常量是为了让 QuestionInput 能用引用相等检测「当前是否费曼角色」，
// 进而把输入框提示语 / 建议词从「提问」切成「讲解」。和本文件已有的
// `PRESETS.find((p) => p.prompt === current)` 是同一套匹配机制。
export const FEYNMAN_PROMPT =
  "你是费曼学习法的「考官」。我会向你讲解一个我正在学习的概念——你的任务不是替我回答、也不是把知识补完整，而是检验并暴露我理解里的漏洞，逼我自己讲清楚。\n\n" +
  "每次我讲完，按这个结构回应：\n" +
  "1. **复述确认**：用一两句话复述你从我的讲解里真正听懂的核心，证明你听进去了；哪句没看懂就直说。\n" +
  "2. **漏洞清单**：逐条点名我讲得模糊、跳步、含糊带过、或可能讲错的地方——尤其是用了术语却没解释、逻辑链有缺口的地方。\n" +
  "3. **追问**：挑其中最关键的 1-2 个薄弱点，用一个外行也会问的、naive 的「为什么 / 那如果……会怎样」问题追问，逼我往下挖。\n\n" +
  "原则：绝不替我把概念补完整（那样就剥夺了费曼法的价值），只暴露问题、提出好问题，让我自己补。语气像一个聪明、好奇但严格的同学，直接、不奉承。";

const PRESETS: Preset[] = [
  { label: "默认助手", prompt: null, hint: "简洁耐心的助教（内置默认）" },
  {
    label: "严谨工程师",
    prompt:
      "你是一名资深软件工程师。给出精确、可执行的技术回答，附带权衡分析与边界情况；代码用代码块并标注语言；不确定就明说，绝不编造 API 或事实。",
    hint: "技术问题首选",
  },
  {
    label: "苏格拉底导师",
    prompt:
      "你是苏格拉底式导师。不要直接给答案，而是用一连串有针对性的问题引导我自己推导；只有在我明显卡住时才给关键提示。",
    hint: "用来学习 / 深入思考",
  },
  {
    label: "费曼考官",
    prompt: FEYNMAN_PROMPT,
    hint: "你讲，AI 挑漏洞 · 费曼学习法",
  },
  {
    label: "犀利评论者",
    prompt:
      "你是直言不讳的批判性评论者。直接指出问题与薄弱点，给出反方视角和更优替代方案，不奉承、不堆砌套话。",
    hint: "压力测试你的想法",
  },
  {
    label: "中英翻译",
    prompt:
      "你是专业中英互译器。只输出译文本身，不加任何解释；保持术语准确、语气自然；代码与专有名词保留原文。",
    hint: "纯翻译，不解释",
  },
];

export function SystemPromptPicker() {
  const draftMode = useSessionStore((s) => s.draftMode);
  const draftSystemPrompt = useSessionStore((s) => s.draftSystemPrompt);
  const setDraftSystemPrompt = useSessionStore((s) => s.setDraftSystemPrompt);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(draftSystemPrompt ?? "");

  // System prompt only applies to chat mode.
  if (draftMode !== "chat") return null;

  const current = draftSystemPrompt;
  const matched = PRESETS.find((p) => p.prompt === current);
  const label = current ? (matched ? matched.label : "自定义角色") : "默认助手";

  const apply = (prompt: string | null) => {
    setDraftSystemPrompt(prompt);
    setText(prompt ?? "");
  };

  return (
    <div className="relative inline-block text-sm">
      <button
        type="button"
        onClick={() => {
          setText(draftSystemPrompt ?? "");
          setOpen((v) => !v);
        }}
        title="设置这个对话的 AI 角色 / 系统提示词"
        className="px-3 py-1.5 rounded-full border border-line bg-surface text-ink-muted hover:border-line-strong transition-colors flex items-center gap-1.5 text-ui"
      >
        <span aria-hidden>🎭</span>
        <span>角色：{label}</span>
        <span className="text-ink-faint" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* 注：这是锚定触发按钮的居中下拉（非标准居中弹窗），保持手写外壳。 */}
          <div className="absolute z-50 mt-2 left-1/2 -translate-x-1/2 w-[340px] bg-surface border border-line rounded-xl shadow-pop p-3 text-left">
            <div className="text-ui text-ink-muted mb-2">
              选一个预设角色，或自定义系统提示词（仅 Chat 模式，创建后锁定）
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {PRESETS.map((p) => {
                const active =
                  p.prompt === current || (p.prompt === null && !current);
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => apply(p.prompt)}
                    title={p.hint}
                    className={`px-2.5 py-1 rounded-full text-ui border transition-colors ${
                      active
                        ? "bg-accent text-ink-inverse border-accent"
                        : "bg-surface-muted text-ink-muted border-line hover:border-line-strong"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="自定义系统提示词……留空则用内置默认"
              className="w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none resize-none focus:border-accent-line"
            />
            <div className="flex items-center justify-end gap-2 mt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  apply(null);
                  setOpen(false);
                }}
              >
                重置默认
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setDraftSystemPrompt(text.trim() ? text : null);
                  setOpen(false);
                }}
              >
                应用
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
