"use client";
import { useEffect, useMemo, useState } from "react";
import { useAgentStore, type Agent, type AgentInput } from "@/stores/agentStore";
import { Button } from "@/components/ui/Button";

// S88: Agent 管理页。整页而非 modal —— 编辑器要装一个大 system prompt textarea +
// 技能多选（本机上百个 skill，要能搜）+ 工具白/黑名单 + 三个开关 + 模型，
// ModelConfigModal 那种 3-5 字段的 modal 装不下。
//
// 左列表右编辑器：改一个 agent 时能一眼看到其余的，避免建出一堆语义重复的人设。

type HostSkill = { name: string; dir: string; description: string };

const EMPTY: AgentInput = {
  slug: "",
  name: "",
  description: "",
  systemPrompt: "",
  model: null,
  tools: null,
  disallowedTools: null,
  skills: [],
  inheritEnv: false,
  enabled: true,
  permission: null,
  requireApproval: null,
};

export default function AgentsSettingsPage() {
  const { agents, loading, error, refresh, create, update, remove } = useAgentStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [hostSkills, setHostSkills] = useState<HostSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setHostSkills(d.skills ?? []))
      .catch(() => setHostSkills([]));
  }, [refresh]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const startEdit = (a: Agent) => {
    setSelectedId(a.id);
    setMsg(null);
    setDraft({
      slug: a.slug,
      name: a.name,
      description: a.description,
      systemPrompt: a.systemPrompt,
      model: a.model,
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      skills: a.skills,
      inheritEnv: a.inheritEnv,
      enabled: a.enabled,
      permission: a.permission,
      requireApproval: a.requireApproval,
    });
  };

  const startNew = () => {
    setSelectedId(null);
    setMsg(null);
    setDraft({ ...EMPTY });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    const r = selectedId ? await update(selectedId, draft) : await create(draft);
    setSaving(false);
    if (r) {
      setSelectedId(r.id);
      setMsg("已保存");
    }
  };

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return hostSkills;
    return hostSkills.filter(
      (s) => s.dir.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    );
  }, [hostSkills, skillQuery]);

  const toggleSkill = (dir: string) => {
    if (!draft) return;
    const cur = draft.skills ?? [];
    const has = cur.some((s) => s.name === dir);
    setDraft({
      ...draft,
      skills: has
        ? cur.filter((s) => s.name !== dir)
        : [...cur, { kind: "host" as const, name: dir }],
    });
  };

  return (
    // S89: 滚动容器与页头由 app/settings/layout.tsx 接管，这里只剩内容。
    <div className="flex flex-col md:flex-row gap-4">
        {/* 左：列表 */}
        <div className="md:w-[280px] shrink-0 flex flex-col gap-2">
          <Button type="button" variant="primary" size="sm" onClick={startNew}>
            + 新建 Agent
          </Button>
          {loading && <div className="text-ui text-ink-faint">加载中…</div>}
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => startEdit(a)}
              className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                selectedId === a.id
                  ? "bg-accent text-ink-inverse border-accent"
                  : "bg-surface border-line hover:border-line-strong"
              } ${a.enabled ? "" : "opacity-50"}`}
            >
              <div className="text-ui font-medium flex items-center gap-1.5">
                {a.name}
                {a.builtin && <span className="text-ink-faint text-label">内置</span>}
                {!a.enabled && <span className="text-ink-faint text-label">已停用</span>}
              </div>
              <div
                className={`text-label font-mono ${selectedId === a.id ? "opacity-75" : "text-ink-faint"}`}
              >
                @{a.slug}
                {!a.inheritEnv && " · 隔离"}
              </div>
            </button>
          ))}
        </div>

        {/* 右：编辑器 */}
        <div className="flex-1 min-w-0">
          {!draft ? (
            <div className="text-ui text-ink-faint py-8">
              左边选一个 Agent 编辑，或新建一个。
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {error && (
                <div className="px-3 py-2 rounded-lg border border-danger-line bg-danger-surface text-ui">
                  {error}
                </div>
              )}
              {msg && <div className="text-ui text-ink-muted">{msg}</div>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="名字（显示用）">
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className={INPUT}
                    placeholder="例如：只读侦察兵"
                  />
                </Field>
                <Field
                  label="slug"
                  hint="小写字母/数字/连字符。是 @提及名，也是底层 --agent 的值，建后别乱改"
                >
                  <input
                    value={draft.slug}
                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                    className={`${INPUT} font-mono`}
                    placeholder="readonly-scout"
                  />
                </Field>
              </div>

              <Field label="一句话说明" hint="会作为 agent 的自述传给模型">
                <input
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className={INPUT}
                  placeholder="只看不能改"
                />
              </Field>

              <Field label="系统提示词" hint="这就是模型收到的全部人设 —— 不与内置默认叠加">
                <textarea
                  value={draft.systemPrompt ?? ""}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={10}
                  className={`${INPUT} resize-y`}
                  placeholder="你是……"
                />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="模型" hint="留空 = 跟随会话当前模型">
                  <input
                    value={draft.model ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value.trim() || null })
                    }
                    className={`${INPUT} font-mono`}
                    placeholder="haiku / claude-opus / deepseek:xxx"
                  />
                </Field>
                <Field
                  label="工具白名单"
                  hint="逗号分隔。留空 = 不限制。配了技能会自动补上 Skill"
                >
                  <input
                    value={draft.tools?.join(", ") ?? ""}
                    onChange={(e) => setDraft({ ...draft, tools: parseList(e.target.value) })}
                    className={`${INPUT} font-mono`}
                    placeholder="Read, Grep, Glob"
                  />
                </Field>
              </div>

              <Field label="工具黑名单" hint="逗号分隔。与白名单正交，可同时给">
                <input
                  value={draft.disallowedTools?.join(", ") ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, disallowedTools: parseList(e.target.value) })
                  }
                  className={`${INPUT} font-mono`}
                  placeholder="Bash"
                />
              </Field>

              {/* 隔离开关 —— 代价必须写全，别让人事后才发现 MCP 没了 */}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.inheritEnv ?? false}
                  onChange={(e) => setDraft({ ...draft, inheritEnv: e.target.checked })}
                  className="mt-1"
                />
                <span className="text-ui">
                  继承本机环境
                  <span className="block text-label text-ink-faint">
                    勾上 = 读 CLAUDE.md、本机全部技能、MCP（适合干活型 agent）。
                    不勾 = 隔离：<b>无 CLAUDE.md、无本机技能、无 MCP</b>，只有下面选中的技能。
                    隔离的 agent 可复现、能整包搬到别的机器。
                  </span>
                </span>
              </label>

              {/* S89: permission / requireApproval 两列后端一直都在（lib/server/agents.ts:31-32、
                  222-226 读写齐全，sdk-adapter.ts:69-77 真的进 spawn），**但此前没有任何编辑
                  入口**，只能拿 API 直接写。这是「表单漏字段」里最贵的一类 —— 它是安全闸。 */}
              <Field
                label="工具权限档位"
                hint="agent 级默认。留空 = 跟随会话（不覆盖）。"
              >
                <select
                  value={draft.permission ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, permission: e.target.value || null })
                  }
                  className={INPUT}
                >
                  <option value="">跟随会话</option>
                  <option value="default">default（按 CLI 默认策略问）</option>
                  <option value="readonly">readonly（只读，不许改动）</option>
                  <option value="auto-edit">auto-edit（文件改动自动放行）</option>
                  <option value="full">full（全部自动放行）</option>
                </select>
              </Field>

              <Field
                label="逐个确认"
                hint={
                  "覆盖会话的 YOLO / 需确认设置。会话侧同一个开关在新建会话时选，" +
                  "两者都设时**以 agent 为准**（与 agent.model 覆盖会话模型同构）。"
                }
              >
                <select
                  value={
                    draft.requireApproval === null || draft.requireApproval === undefined
                      ? ""
                      : draft.requireApproval
                        ? "yes"
                        : "no"
                  }
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      requireApproval:
                        e.target.value === "" ? null : e.target.value === "yes",
                    })
                  }
                  className={INPUT}
                >
                  <option value="">跟随会话</option>
                  <option value="yes">需确认（可变更工具逐个弹卡）</option>
                  <option value="no">YOLO（自动放行）</option>
                </select>
              </Field>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.enabled ?? true}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                <span className="text-ui">启用（停用后不在 picker 里出现，老会话静默退回默认人设）</span>
              </label>

              {/* S89 命名消歧：这里的「技能」与输入框里 `/xxx` 补全出的「技能」是同一批
                  ~/.claude/skills/ 目录，但走两条完全不同的路 —— 这边是 pack + symlink
                  物化后由 `Skill` 工具调起（且隔离 agent 只有这里选中的这些），那边是
                  纯文本补全交给 CLI。所以叫「挂载技能」而不是「技能」。 */}
              <Field
                label={`挂载技能（已选 ${draft.skills?.length ?? 0}）`}
                hint="从本机 ~/.claude/skills/ 挂给这个 agent，由 Skill 工具调起（与输入框 / 补全的技能是同一批目录，但那条是把技能名补进提问里，不受这里影响）。改技能正文自动跟随，不用重新保存"
              >
                <input
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  className={`${INPUT} mb-2`}
                  placeholder="搜索技能…"
                />
                <div className="max-h-[220px] overflow-y-auto flex flex-wrap gap-1.5 p-2 rounded-field border border-line bg-surface-muted">
                  {filteredSkills.map((s) => {
                    const on = draft.skills?.some((x) => x.name === s.dir) ?? false;
                    return (
                      <button
                        key={s.dir}
                        type="button"
                        title={s.description}
                        onClick={() => toggleSkill(s.dir)}
                        className={`px-2 py-1 rounded-full text-label border font-mono transition-colors ${
                          on
                            ? "bg-accent text-ink-inverse border-accent"
                            : "bg-surface text-ink-muted border-line hover:border-line-strong"
                        }`}
                      >
                        {s.dir}
                      </button>
                    );
                  })}
                  {!filteredSkills.length && (
                    <span className="text-label text-ink-faint">没有匹配的技能</span>
                  )}
                </div>
              </Field>

              <div className="flex items-center gap-2 pt-2 border-t border-line">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || !draft.slug.trim() || !draft.name.trim()}
                >
                  {saving ? "保存中…" : selectedId ? "保存" : "创建"}
                </Button>
                {selected && !selected.builtin && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (!confirm(`删除 Agent「${selected.name}」？用过它的历史会话会退回默认人设。`))
                        return;
                      if (await remove(selected.id)) {
                        setSelectedId(null);
                        setDraft(null);
                      }
                    }}
                  >
                    删除
                  </Button>
                )}
                {selected?.builtin && (
                  <span className="text-label text-ink-faint">
                    内置 Agent 不可删除 —— 想让它消失请取消「启用」
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
    </div>
  );
}

const INPUT =
  "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-ui font-medium mb-1">{label}</div>
      {hint && <div className="text-label text-ink-faint mb-1">{hint}</div>}
      {children}
    </div>
  );
}

/** 逗号/空格分隔 → 数组。全空返回 null（= 不限制），不是空数组（= 一个都不给）。 */
function parseList(raw: string): string[] | null {
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}
