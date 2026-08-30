"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentStore, type Agent, type AgentInput } from "@/stores/agentStore";
import { Button } from "@/components/ui/Button";
import type { ProviderInfo } from "@/lib/llm";
import type { LarkBot } from "@/lib/lark-types";

// S88: Agent 管理页。整页而非 modal —— 编辑器要装一个大 system prompt textarea +
// 技能多选（本机上百个 skill，要能搜）+ 工具白/黑名单 + 三个开关 + 模型，
// ModelConfigModal 那种 3-5 字段的 modal 装不下。
//
// 左列表右编辑器：改一个 agent 时能一眼看到其余的，避免建出一堆语义重复的人设。

type HostSkill = { name: string; dir: string; description: string };

type DiscoveredBot = {
  appId: string;
  name: string;
  openId: string | null;
  source: string;
  sourceType: "feishu-cli" | "lark-cli" | "env" | "agent-gateway";
  online: boolean;
  error?: string;
  alreadyRegistered: boolean;
  registeredBotId: string | null;
  boundAgentId: string | null;
  boundAgentName: string | null;
  boundAgentSlug: string | null;
};

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

const FEISHU_LAUNCHER_URL = "https://open.feishu.cn/page/launcher?from=backend_oneclick";
const LARK_LAUNCHER_URL = "https://open.larkoffice.com/page/launcher?from=backend_oneclick";

export default function AgentsSettingsPage() {
  const { agents, loading, error, refresh, create, update, remove } = useAgentStore();
  const [bots, setBots] = useState<LarkBot[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredBot[]>([]);
  const [botToBind, setBotToBind] = useState<string>("");
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [createBotModalOpen, setCreateBotModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [hostSkills, setHostSkills] = useState<HostSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ProviderInfo[]>([]);

  const refreshBots = useCallback(async () => {
    try {
      const [botRes, discRes] = await Promise.allSettled([
        fetch("/api/lark-bots").then((r) => r.json()),
        fetch("/api/lark-bots/discover").then((r) => r.json()),
      ]);
      if (botRes.status === "fulfilled" && botRes.value.bots) {
        setBots(botRes.value.bots);
      }
      if (discRes.status === "fulfilled" && discRes.value.discovered) {
        setDiscovered(discRes.value.discovered);
      }
    } catch {
      setBots([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBots();
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setHostSkills(d.skills ?? []))
      .catch(() => setHostSkills([]));
    fetch("/api/providers")
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((d) => setCatalog(d.providers ?? []))
      .catch(() => setCatalog([]));

    const timer = setInterval(() => void refreshBots(), 10_000);
    return () => clearInterval(timer);
  }, [refresh, refreshBots]);

  // 处理 URL query params（如 ?id=xxx 或 ?new=1）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new") === "1";
    const idParam = params.get("id");
    if (newParam) {
      setSelectedId(null);
      setDraft({ ...EMPTY });
    } else if (idParam) {
      setSelectedId(idParam);
    }
  }, []);

  // 当外部指定 id 或列表初次加载时回填草稿
  useEffect(() => {
    if (selectedId && !draft && agents.length > 0) {
      const a = agents.find((x) => x.id === selectedId);
      if (a) {
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
      }
    }
  }, [selectedId, draft, agents]);

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
        {agents.map((a) => {
          const agentBots = bots.filter((b) => b.agentId === a.id);
          return (
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
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className={`text-label font-mono truncate ${
                    selectedId === a.id ? "opacity-75" : "text-ink-faint"
                  }`}
                >
                  @{a.slug}
                  {!a.inheritEnv && " · 隔离"}
                </span>
                {agentBots.length > 0 && (
                  <span
                    className={`text-nano px-1.5 py-0.2 rounded font-sans shrink-0 ${
                      selectedId === a.id
                        ? "bg-white/20 text-current"
                        : "bg-accent-muted text-accent-ink"
                    }`}
                  >
                    💬 {agentBots.length === 1 ? (agentBots[0].botName || agentBots[0].name) : `${agentBots.length} 机器人`}
                  </span>
                )}
              </div>
            </button>
          );
        })}
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
                <div className="space-y-1.5">
                  <input
                    value={draft.model ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value.trim() || null })
                    }
                    className={`${INPUT} font-mono`}
                    placeholder="haiku / gpt-5.5 / deepseek:xxx"
                  />
                  <div className="flex flex-wrap gap-1">
                    {[
                      { label: "跟随会话", value: null },
                      { label: "haiku", value: "haiku" },
                      { label: "sonnet", value: "sonnet" },
                      { label: "opus", value: "opus" },
                      { label: "codex", value: "codex" },
                      { label: "gpt-5.5", value: "gpt-5.5" },
                    ].map((chip) => {
                      const active =
                        chip.value === null ? !draft.model : draft.model === chip.value;
                      return (
                        <button
                          key={chip.label}
                          type="button"
                          onClick={() => setDraft({ ...draft, model: chip.value })}
                          className={`px-1.5 py-0.5 text-nano rounded-md border transition-colors ${
                            active
                              ? "bg-accent-muted text-accent-ink border-accent-line font-medium"
                              : "bg-surface-muted text-ink-muted hover:text-ink border-line"
                          }`}
                        >
                          {chip.label}
                        </button>
                      );
                    })}
                  </div>
                  {catalog.length > 0 && (
                    <select
                      className="w-full px-2 py-1 text-label rounded-field border border-line bg-surface text-ink outline-none"
                      value={draft.model ?? ""}
                      onChange={(e) =>
                        setDraft({ ...draft, model: e.target.value || null })
                      }
                    >
                      <option value="">-- 从可用模型列表中选择 --</option>
                      {catalog.map((p) => (
                        <option key={p.id} value={p.shortLabel}>
                          {p.label} ({p.shortLabel})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </Field>
              <Field
                label="工具白名单"
                hint="Claude 生效；Codex exec 无法强制工具名单。逗号分隔，留空 = 不限制；配了技能会自动补 Skill"
              >
                <input
                  value={draft.tools?.join(", ") ?? ""}
                  onChange={(e) => setDraft({ ...draft, tools: parseList(e.target.value) })}
                  className={`${INPUT} font-mono`}
                  placeholder="Read, Grep, Glob"
                />
              </Field>
            </div>

            <Field label="工具黑名单" hint="Claude 生效；Codex exec 无法强制。与白名单正交，可同时给">
              <input
                value={draft.disallowedTools?.join(", ") ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, disallowedTools: parseList(e.target.value) })
                }
                className={`${INPUT} font-mono`}
                placeholder="Bash"
              />
            </Field>

            {/* 隔离开关 */}
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
                  勾上 = 读当前 provider 的项目说明、本机全部技能、MCP（适合干活型 agent）。
                  不勾 = 隔离：<b>无项目说明、无环境技能、无 MCP</b>，只有下面选中的技能。
                  隔离的 agent 可复现、能整包搬到别的机器。
                </span>
              </span>
            </label>

            {/* S89: permission / requireApproval */}
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
                "两者都设时以 agent 为准。Claude / Codex 均支持逐项审批（Codex 的可信白名单命令会自动放行）。"
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

            {/* 挂载技能 */}
            <Field
              label={`挂载技能（已选 ${draft.skills?.length ?? 0}）`}
              hint="从本机 ~/.claude/skills/ 挂给这个 agent。Claude 通过 Skill 工具加载；Codex 会内联 SKILL.md 并保留源目录供脚本/引用解析。改正文自动跟随，不用重新保存"
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

            {/* 渠道绑定 / 飞书机器人接入 */}
            {selected && (
              <section className="rounded-xl border border-line bg-surface p-4 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-ui font-semibold flex items-center gap-2">
                      <span>💬 飞书机器人接入</span>
                      <span className="text-label text-ink-faint">
                        ({bots.filter((b) => b.agentId === selected.id).length})
                      </span>
                    </div>
                    <div className="text-label text-ink-faint mt-0.5">
                      接入飞书自建应用。飞书用户发消息时将直接以该 Agent 的人设、模型与挂载技能作答。
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => setCreateBotModalOpen(true)}
                    >
                      + 接入飞书机器人
                    </Button>
                    <a
                      href={FEISHU_LAUNCHER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2 py-1 text-label rounded-md border border-line hover:border-line-strong text-ink hover:text-ink-strong transition-colors"
                      title="打开飞书开放平台 Launcher 模板快速创建机器人应用"
                    >
                      ⚡ 飞书一键创建 (Launcher) ↗
                    </a>
                    <Link
                      href={`/settings/bots?new=1&agentId=${encodeURIComponent(selected.id)}`}
                      className="px-2 py-1 text-label rounded-md border border-line hover:border-line-strong text-ink hover:text-ink-strong transition-colors"
                      title="打开完整机器人设置向导"
                    >
                      向导页 ↗
                    </Link>
                  </div>
                </div>

                {/* 本机已发现应用一键接入（免输入 App ID / Secret） */}
                {discovered.filter((d) => d.boundAgentId !== selected.id).length > 0 && (
                  <div className="rounded-lg border border-accent-line bg-accent-muted/20 p-3 space-y-2">
                    <div className="text-ui font-medium text-ink flex items-center gap-1.5">
                      <span>✨ 检测到本机已配置的飞书应用（免复制凭证，一键直连绑定）：</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {discovered
                        .filter((d) => d.boundAgentId !== selected.id)
                        .map((disc) => (
                          <div
                            key={disc.appId}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-line bg-surface shadow-sm"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-ui text-ink truncate">
                                🤖 {disc.name}
                              </div>
                              <div className="text-nano font-mono text-ink-faint truncate">
                                {disc.appId} · {disc.source}
                              </div>
                              {disc.alreadyRegistered && disc.boundAgentName && (
                                <div className="text-nano text-ink-faint truncate">
                                  当前绑定于: @{disc.boundAgentSlug}
                                </div>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="shrink-0 text-xs"
                              disabled={botBusy === `import-${disc.appId}`}
                              onClick={async () => {
                                setBotBusy(`import-${disc.appId}`);
                                try {
                                  const res = await fetch("/api/lark-bots/import-local", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      appId: disc.appId,
                                      name: disc.name,
                                      agentId: selected.id,
                                    }),
                                  });
                                  if (!res.ok) throw new Error("接入失败");
                                  await refreshBots();
                                  setMsg(`🎉 已成功将飞书应用「${disc.name}」一键接入并绑定到 Agent「${selected.name}」！`);
                                } catch (e) {
                                  setMsg(e instanceof Error ? e.message : "接入失败");
                                } finally {
                                  setBotBusy(null);
                                }
                              }}
                            >
                              {botBusy === `import-${disc.appId}` ? "接入中…" : "⚡ 一键接入"}
                            </Button>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {(() => {
                  const boundBots = bots.filter((b) => b.agentId === selected.id);
                  const otherBots = bots.filter((b) => b.agentId !== selected.id);

                  return (
                    <div className="flex flex-col gap-3">
                      {boundBots.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-ui text-ink-faint">
                          <div>当前 Agent 尚未绑定飞书机器人。</div>
                          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              onClick={() => setCreateBotModalOpen(true)}
                            >
                              + 手动录入并绑定
                            </Button>
                            {otherBots.length > 0 && (
                              <div className="flex items-center gap-1.5">
                                <select
                                  className="px-2 py-1 text-label rounded-field border border-line bg-surface text-ink outline-none"
                                  value={botToBind}
                                  onChange={(e) => setBotToBind(e.target.value)}
                                >
                                  <option value="">-- 选择已有机器人绑定 --</option>
                                  {otherBots.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.botName || b.name} ({b.appId})
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  disabled={!botToBind || botBusy !== null}
                                  onClick={async () => {
                                    if (!botToBind) return;
                                    setBotBusy(botToBind);
                                    try {
                                      const res = await fetch(`/api/lark-bots/${botToBind}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ agentId: selected.id }),
                                      });
                                      if (!res.ok) throw new Error("绑定失败");
                                      await refreshBots();
                                      setBotToBind("");
                                      setMsg("飞书机器人绑定成功");
                                    } catch (e) {
                                      setMsg(e instanceof Error ? e.message : "绑定失败");
                                    } finally {
                                      setBotBusy(null);
                                    }
                                  }}
                                >
                                  绑定
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {boundBots.map((bot) => (
                            <div
                              key={bot.id}
                              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-line bg-surface-muted"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-ui truncate">
                                    {bot.botName || bot.name}
                                  </span>
                                  <BotStatusBadge bot={bot} />
                                </div>
                                <div className="text-label text-ink-faint font-mono truncate mt-0.5">
                                  {bot.appId}
                                  {bot.workspacePath && ` · ${bot.workspacePath}`}
                                  {bot.lastConnectedAt &&
                                    ` · 最近连接 ${new Date(bot.lastConnectedAt).toLocaleTimeString()}`}
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Link
                                  href={`/settings/bots?id=${encodeURIComponent(bot.id)}`}
                                  className="px-2.5 py-1 text-label rounded-md border border-line hover:border-line-strong text-ink hover:text-ink-strong transition-colors"
                                >
                                  配置 ↗
                                </Link>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={botBusy === bot.id}
                                  onClick={async () => {
                                    if (!confirm(`解绑机器人「${bot.name}」？该机器人将退回默认助手。`))
                                      return;
                                    setBotBusy(bot.id);
                                    try {
                                      const res = await fetch(`/api/lark-bots/${bot.id}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ agentId: null }),
                                      });
                                      if (!res.ok) throw new Error("解绑失败");
                                      await refreshBots();
                                      setMsg("已解绑飞书机器人");
                                    } catch (e) {
                                      setMsg(e instanceof Error ? e.message : "解绑失败");
                                    } finally {
                                      setBotBusy(null);
                                    }
                                  }}
                                >
                                  解绑
                                </Button>
                              </div>
                            </div>
                          ))}

                          {otherBots.length > 0 && (
                            <div className="flex items-center gap-2 pt-2 border-t border-line mt-1">
                              <select
                                className="flex-1 px-2 py-1 text-label rounded-field border border-line bg-surface text-ink outline-none"
                                value={botToBind}
                                onChange={(e) => setBotToBind(e.target.value)}
                              >
                                <option value="">-- 绑定其他已有机器人 --</option>
                                {otherBots.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.botName || b.name} ({b.appId})
                                  </option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={!botToBind || botBusy !== null}
                                onClick={async () => {
                                  if (!botToBind) return;
                                  setBotBusy(botToBind);
                                  try {
                                    const res = await fetch(`/api/lark-bots/${botToBind}`, {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ agentId: selected.id }),
                                    });
                                    if (!res.ok) throw new Error("绑定失败");
                                    await refreshBots();
                                    setBotToBind("");
                                    setMsg("飞书机器人绑定成功");
                                  } catch (e) {
                                    setMsg(e instanceof Error ? e.message : "绑定失败");
                                  } finally {
                                    setBotBusy(null);
                                  }
                                }}
                              >
                                绑定到此 Agent
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </section>
            )}

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

      {selected && (
        <QuickCreateBotModal
          open={createBotModalOpen}
          agent={selected}
          discovered={discovered.filter((d) => d.boundAgentId !== selected.id)}
          onClose={() => setCreateBotModalOpen(false)}
          onSuccess={async (botName) => {
            await refreshBots();
            setMsg(`🎉 飞书机器人「${botName}」已成功接入并绑定到 Agent「${selected.name}」！`);
          }}
        />
      )}
    </div>
  );
}

function QuickCreateBotModal({
  open,
  agent,
  discovered,
  onClose,
  onSuccess,
}: {
  open: boolean;
  agent: Agent;
  discovered: DiscoveredBot[];
  onClose: () => void;
  onSuccess: (botName: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(`${agent.name}助手`);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleImportDisc = async (disc: DiscoveredBot) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lark-bots/import-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: disc.appId,
          name: disc.name,
          agentId: agent.id,
          workspacePath: workspacePath.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "导入失败");
      await onSuccess(data.testedName || data.bot.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !appId.trim() || !appSecret.trim()) {
      setError("请填写应用名称、App ID 和 App Secret");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 1. 创建机器人并绑定当前 Agent
      const res = await fetch("/api/lark-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          agentId: agent.id,
          workspacePath: workspacePath.trim() || null,
          enabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");

      // 2. 自动测试凭证
      try {
        await fetch(`/api/lark-bots/${data.bot.id}/test`, { method: "POST" });
      } catch {
        // test error non-fatal
      }

      await onSuccess(data.bot.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface border border-line rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-ui font-semibold">接入飞书机器人</h2>
            <p className="text-label text-ink-faint mt-0.5">
              绑定执行人设：<span className="font-medium text-ink">{agent.name}</span> (@{agent.slug})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink text-sm p-1"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg border border-danger-line bg-danger-muted text-danger-ink text-ui">
            {error}
          </div>
        )}

        {/* 快捷 Launcher 引导 */}
        <div className="rounded-lg border border-line bg-surface-muted p-2.5 flex flex-wrap items-center justify-between gap-2 text-label">
          <span className="text-ink-muted">尚未创建飞书应用？可通过官方 Launcher 模板一键秒级生成：</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href={FEISHU_LAUNCHER_URL}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-0.5 rounded bg-accent text-ink-inverse hover:bg-accent-strong text-nano font-medium transition-colors"
            >
              ⚡ 飞书一键创建 (Launcher) ↗
            </a>
            <a
              href={LARK_LAUNCHER_URL}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-0.5 rounded border border-line bg-surface text-ink hover:text-ink-strong text-nano transition-colors"
            >
              Lark 国际版 ↗
            </a>
          </div>
        </div>

        {/* 发现的本地应用免复制区 */}
        {discovered.length > 0 && (
          <div className="rounded-lg border border-accent-line bg-accent-muted/20 p-3 space-y-2">
            <div className="text-label font-medium text-ink">
              ✨ 从本机已发现的应用一键接入（免填写凭证）：
            </div>
            <div className="flex flex-col gap-1.5">
              {discovered.map((disc) => (
                <div
                  key={disc.appId}
                  className="flex items-center justify-between gap-2 p-2 rounded-md bg-surface border border-line"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-ui truncate text-ink">
                      🤖 {disc.name}
                    </div>
                    <div className="text-nano font-mono text-ink-faint truncate">
                      {disc.appId} · {disc.source}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="shrink-0 text-xs"
                    disabled={busy}
                    onClick={() => void handleImportDisc(disc)}
                  >
                    ⚡ 一键接入
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="text-label text-ink-muted font-medium pt-1">或手动输入凭证接入：</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="配置名称" hint="例如：研发助手">
              <input
                className={INPUT}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：苏格拉底导师"
                required
              />
            </Field>
            <Field label="飞书 App ID" hint="开放平台 cli_ 开头标识">
              <input
                className={`${INPUT} font-mono`}
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                required
              />
            </Field>
          </div>

          <Field label="飞书 App Secret" hint="在开放平台“凭证与基础信息”中复制">
            <input
              className={`${INPUT} font-mono`}
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="请输入 app_secret"
              required
            />
          </Field>

          <Field label="工作目录（选填）" hint="留空使用聊天工作区；填写后以 project 模式在该目录执行">
            <input
              className={`${INPUT} font-mono`}
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="/absolute/path/to/project"
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-line mt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim() || !appId.trim() || !appSecret.trim()}>
              {busy ? "正在接入与测试…" : "手动测试并接入"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BotStatusBadge({ bot }: { bot: LarkBot }) {
  const text = !bot.enabled ? "已停用" : bot.lastError ? "异常" : bot.lastConnectedAt ? "已连接" : "待连接";
  const tone = bot.lastError
    ? "bg-danger-muted text-danger-ink border-danger-line"
    : bot.lastConnectedAt && bot.enabled
      ? "bg-accent-muted text-accent-ink border-accent-line"
      : "bg-surface-muted text-ink-faint border-line";
  return <span className={`px-1.5 py-0.5 rounded-full border text-nano ${tone}`}>{text}</span>;
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

function parseList(raw: string): string[] | null {
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : null;
}
