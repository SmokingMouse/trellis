"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "@/components/ui/Button";
import {
  AGENT_DEFAULT_HINT,
  AGENT_DEFAULT_LABEL,
  AGENT_UNSUPPORTED_HINT,
  agentHint,
  agentSupported,
} from "@/lib/run-config";
import { providerFamily } from "@/lib/llm";

// S88: 选下一个新会话的 Agent（人设 + 模型 + 工具 + 技能 + 隔离度）。
//
// 取代 SystemPromptPicker：那个只有 6 个硬编码预设、只在 chat 模式露面、且存的是
// 一坨没有 id 的文本。现在预设是 agents 表里的 builtin 行，两个 mode 都能选，
// 且有稳定 id 供定时任务 / @提及 / 讨论组按引用取用。
//
// 「默认助手」是伪条目 —— 它不是一行数据，而是 agentId === null 这个状态本身。
// 选它 = 执行链走今天的老路一行不变。
//
// 自定义 system prompt 的入口保留（textarea），但**只在没选 agent 时可用**：
// --agent 与 --system-prompt 在 CLI 层就是互斥的，UI 上让它们同时亮着是骗人。
//
// S89：文案（「默认助手」这个名字、隔离提示的措辞）搬去 lib/run-config.ts —— 任务定义页
// 引用同一份，此前两处各叫一个名字。

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  inheritEnv: boolean;
  builtin: boolean;
  tools: string[] | null;
  skills: unknown[];
};

export function AgentPicker() {
  const draftMode = useSessionStore((s) => s.draftMode);
  const draftSystemPrompt = useSessionStore((s) => s.draftSystemPrompt);
  const setDraftSystemPrompt = useSessionStore((s) => s.setDraftSystemPrompt);
  const draftAgentId = useSessionStore((s) => s.draftAgentId);
  const setDraftAgentId = useSessionStore((s) => s.setDraftAgentId);
  const provider = useSessionStore((s) => s.provider);

  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [text, setText] = useState(draftSystemPrompt ?? "");

  // 只在打开时拉一次 —— agent 列表变动频率极低，没必要常驻订阅。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        if (alive) setAgents(d.agents ?? []);
      })
      .catch(() => {
        /* 列表拉不到就只剩「默认助手」，不挡住发消息 */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const selected = agents.find((a) => a.id === draftAgentId) ?? null;
  const label = draftAgentId
    ? (selected?.name ?? "已选 Agent")
    : draftSystemPrompt
      ? "自定义角色"
      : AGENT_DEFAULT_LABEL;

  // Mock does not execute agents. Both real provider families do.
  // 原来这里直接 return null 整个消失 —— 但如果用户**已经选了** agent 再换模型，
  // 那个选择就无声无息地失效了。改成：选过就留一枚灰 chip 说明白，没选过才不出现
  // （没选过时它没有任何可说的，出现只是噪音）。
  if (!agentSupported(provider)) {
    if (!draftAgentId) return null;
    return (
      <span
        title={AGENT_UNSUPPORTED_HINT}
        className="px-3 py-1.5 rounded-full border border-line bg-surface-muted text-ink-faint text-ui inline-flex items-center gap-1.5"
      >
        <span aria-hidden>🎭</span>
        <span className="line-through">Agent：{label}</span>
      </span>
    );
  }

  const pickAgent = (id: string | null) => {
    setDraftAgentId(id);
    // 选了 agent 就清掉自定义 prompt：两者互斥，留着只会让人以为它还在生效。
    if (id) {
      setDraftSystemPrompt(null);
      setText("");
    }
  };

  return (
    <div className="relative inline-block text-sm">
      <button
        type="button"
        onClick={() => {
          setText(draftSystemPrompt ?? "");
          setOpen((v) => !v);
        }}
        title="选择这个对话用哪个 Agent（人设 / 模型 / 工具 / 技能）"
        className="px-3 py-1.5 rounded-full border border-line bg-surface text-ink-muted hover:border-line-strong transition-colors flex items-center gap-1.5 text-ui"
      >
        <span aria-hidden>🎭</span>
        <span>Agent：{label}</span>
        <span className="text-ink-faint" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* 注：这是锚定触发按钮的居中下拉（非标准居中弹窗），保持手写外壳。 */}
          <div className="absolute z-50 mt-2 left-1/2 -translate-x-1/2 w-[360px] bg-surface border border-line rounded-xl shadow-pop p-3 text-left">
            <div className="text-ui text-ink-muted mb-2">
              选一个 Agent（创建后锁定）
            </div>
            {providerFamily(provider) === "codex" && (
              <div className="text-label text-ink-faint mb-2">
                Codex：人设、模型、静态权限、隔离、挂载技能与逐项审批生效；工具白/黑名单不支持。
              </div>
            )}
            <div className="flex flex-col gap-1 mb-3 max-h-[240px] overflow-y-auto">
              <AgentRow
                name={AGENT_DEFAULT_LABEL}
                hint={AGENT_DEFAULT_HINT}
                active={!draftAgentId}
                onClick={() => pickAgent(null)}
              />
              {agents.map((a) => (
                <AgentRow
                  key={a.id}
                  name={a.name}
                  hint={agentHint(a, provider)}
                  active={draftAgentId === a.id}
                  onClick={() => pickAgent(a.id)}
                />
              ))}
            </div>

            {/* 自定义 system prompt：仅 chat + 未选 agent 时可用（见文件头注释）。 */}
            {draftMode === "chat" && !draftAgentId && (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  placeholder="或直接写一段自定义系统提示词……留空则用内置默认"
                  className="w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none resize-none focus:border-accent-line"
                />
                <div className="flex items-center justify-end gap-2 mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraftSystemPrompt(null);
                      setText("");
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
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AgentRow({
  name,
  hint,
  active,
  onClick,
}: {
  name: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-2.5 py-1.5 rounded-lg border transition-colors ${
        active
          ? "bg-accent text-ink-inverse border-accent"
          : "bg-surface-muted text-ink-muted border-line hover:border-line-strong"
      }`}
    >
      <div className="text-ui font-medium">{name}</div>
      {hint && (
        <div className={`text-ui ${active ? "opacity-80" : "text-ink-faint"}`}>
          {hint}
        </div>
      )}
    </button>
  );
}
