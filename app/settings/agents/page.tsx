"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentStore, type Agent, type AgentInput } from "@/stores/agentStore";
import {
  ArrowUpRight,
  Bot,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  cn,
  toast,
  useConfirm,
  Spinner,
} from "@/components/ui";
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

// Radix Select 不允许空串 value：「跟随会话 / 未选」用哨兵值。
const INHERIT = "__inherit__";
const NONE = "__none__";

const PERMISSION_OPTIONS = [
  { value: INHERIT, label: "跟随会话" },
  { value: "default", label: "默认", description: "按 CLI 默认策略逐项询问" },
  { value: "readonly", label: "只读", description: "不允许任何改动" },
  { value: "auto-edit", label: "自动批准文件改动", description: "文件改动自动放行，其余仍询问" },
  { value: "full", label: "全部自动批准", description: "所有工具调用自动放行" },
];
const APPROVAL_OPTIONS = [
  { value: INHERIT, label: "跟随会话" },
  { value: "yes", label: "需确认", description: "会改动东西的工具逐个弹卡确认" },
  { value: "no", label: "自动批准", description: "不逐个确认，直接放行" },
];

const FEISHU_LAUNCHER_URL = "https://open.feishu.cn/page/launcher?from=backend_oneclick";
const LARK_LAUNCHER_URL = "https://open.larkoffice.com/page/launcher?from=backend_oneclick";

export default function AgentsSettingsPage() {
  const { agents, loading, error, refresh, create, update, remove } = useAgentStore();
  const confirm = useConfirm();
  // store 的 loading 初始为 false：挂载后第一次 refresh 完成前也算「首次加载」。
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [bots, setBots] = useState<LarkBot[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredBot[]>([]);
  const [botToBind, setBotToBind] = useState<string>(NONE);
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [createBotModalOpen, setCreateBotModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [hostSkills, setHostSkills] = useState<HostSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [saving, setSaving] = useState(false);
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
    void Promise.resolve(refresh()).finally(() => setLoadedOnce(true));
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
    setDraft({ ...EMPTY });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const r = selectedId ? await update(selectedId, draft) : await create(draft);
    setSaving(false);
    if (r) {
      setSelectedId(r.id);
      toast.success(selectedId ? "已保存" : "已创建");
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

  const bindBot = async (botId: string) => {
    if (!selected || botId === NONE) return;
    setBotBusy(botId);
    try {
      const res = await fetch(`/api/lark-bots/${botId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selected.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshBots();
      setBotToBind(NONE);
      toast.success("飞书机器人已绑定");
    } catch {
      toast.error("绑定失败", { description: "稍后重试；一直失败就去「飞书机器人」页看连接状态。" });
    } finally {
      setBotBusy(null);
    }
  };

  const unbindBot = async (bot: LarkBot) => {
    const ok = await confirm({
      title: `解绑机器人「${bot.name}」？`,
      description: "解绑后这个机器人会退回默认助手作答；机器人本身和它的会话都保留，随时可以再绑回来。",
      confirmLabel: "解绑",
      danger: true,
    });
    if (!ok) return;
    setBotBusy(bot.id);
    try {
      const res = await fetch(`/api/lark-bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshBots();
      toast.success("已解绑飞书机器人");
    } catch {
      toast.error("解绑失败", { description: "稍后重试。" });
    } finally {
      setBotBusy(null);
    }
  };

  const importDiscovered = async (disc: DiscoveredBot) => {
    if (!selected) return;
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshBots();
      toast.success(`已接入「${disc.name}」`, {
        description: `飞书应用已绑定到 Agent「${selected.name}」。`,
      });
    } catch {
      toast.error("接入失败", { description: "稍后重试，或改用手动录入凭证。" });
    } finally {
      setBotBusy(null);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: `删除 Agent「${selected.name}」？`,
      description: "用过它的历史会话会退回默认人设；这个操作无法撤销。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    if (await remove(selected.id)) {
      setSelectedId(null);
      setDraft(null);
      toast.success("Agent 已删除");
    }
  };

  const firstLoading = !loadedOnce || (loading && !agents.length);
  const enabledCount = agents.filter((a) => a.enabled).length;

  return (
    // S89: 滚动容器与外壳由 app/settings/layout.tsx 接管，这里只剩内容。
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Agent"
        count={firstLoading ? undefined : agents.length}
        countUnit="个 Agent"
        subtitle={firstLoading ? undefined : `${enabledCount} 个启用`}
        actions={
          <>
            <IconButton
              label="刷新"
              onClick={() => {
                void refresh();
                void refreshBots();
              }}
              disabled={loading}
            >
              {loading ? <Spinner label={null} /> : <Icon icon={RefreshCw} />}
            </IconButton>
            <Button variant="primary" onClick={startNew}>
              <Icon icon={Plus} />
              新建 Agent
            </Button>
          </>
        }
      />

      {firstLoading ? (
        <div role="status" aria-label="加载中" className="flex flex-col md:flex-row gap-6">
          <div className="md:w-[280px] shrink-0 rounded-card border border-line bg-surface divide-y divide-line-faint">
            {[0, 1, 2].map((i) => (
              <div key={i} className="px-3.5 py-3 flex flex-col gap-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            ))}
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      ) : error && !agents.length ? (
        <ErrorCallout error={error} title="Agent 列表加载失败" onRetry={() => void refresh()} />
      ) : !agents.length && !draft ? (
        <EmptyState
          icon={Bot}
          title="还没有 Agent"
          description="Agent 是一套可复用的人设：系统提示词、模型、挂载技能和工具权限。建好后在新会话或飞书机器人里选用。"
          action={
            <Button variant="primary" onClick={startNew}>
              <Icon icon={Plus} />
              新建 Agent
            </Button>
          }
          className="rounded-card border border-line"
        />
      ) : (
    <div className="flex flex-col md:flex-row gap-6">
      {/* 左：列表 */}
      {agents.length > 0 && (
      <div className="md:w-[280px] shrink-0 self-start w-full overflow-hidden rounded-card border border-line bg-surface divide-y divide-line-faint">
        {agents.map((a) => {
          const agentBots = bots.filter((b) => b.agentId === a.id);
          const active = selectedId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => startEdit(a)}
              className={cn(
                "relative flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left transition-colors duration-100 max-md:min-h-11",
                active ? "bg-accent-muted" : "hover:bg-surface-hover",
                !a.enabled && "opacity-60",
              )}
            >
              {active && (
                <span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-accent" />
              )}
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-ui font-medium text-ink-strong">{a.name}</span>
                {a.builtin && <Badge>内置</Badge>}
                {!a.enabled && <Badge>已停用</Badge>}
              </span>
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate font-mono text-label text-ink-muted">
                  @{a.slug}
                  {!a.inheritEnv && " · 隔离"}
                </span>
                {agentBots.length > 0 && (
                  <Badge variant="accent" className="shrink-0">
                    <Icon icon={MessagesSquare} size="sm" />
                    {agentBots.length === 1
                      ? agentBots[0].botName || agentBots[0].name
                      : `${agentBots.length} 个机器人`}
                  </Badge>
                )}
              </span>
            </button>
          );
        })}
      </div>
      )}

      {/* 右：编辑器 */}
      <div className="flex-1 min-w-0">
        {!draft ? (
          <EmptyState
            compact
            title="选一个 Agent 编辑"
            description="左边选一个 Agent 编辑，或在右上角新建一个。"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <h2 className="text-body font-semibold text-ink-strong">
              {selected ? `编辑「${selected.name}」` : "新建 Agent"}
            </h2>
            {error && <ErrorCallout compact error={error} title="保存没有成功" />}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="名字（显示用）">
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：只读侦察兵"
                />
              </Field>
              <Field
                label="标识名"
                hint="小写字母 / 数字 / 连字符。是 @提及名，也是底层 --agent 的值，建好后别乱改"
              >
                <Input
                  value={draft.slug}
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                  className="font-mono"
                  placeholder="readonly-scout"
                />
              </Field>
            </div>

            <Field label="一句话说明" hint="会作为 Agent 的自述传给模型">
              <Input
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="只看不能改"
              />
            </Field>

            <Field label="系统提示词" hint="这就是模型收到的全部人设 —— 不与内置默认叠加">
              <Textarea
                value={draft.systemPrompt ?? ""}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                rows={10}
                className="resize-y"
                placeholder="你是……"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="模型" hint="留空 = 跟随会话当前模型">
                <div className="flex flex-col gap-1.5">
                  <Input
                    value={draft.model ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value.trim() || null })
                    }
                    className="font-mono"
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
                          aria-pressed={active}
                          onClick={() => setDraft({ ...draft, model: chip.value })}
                          className={cn(
                            "px-1.5 py-0.5 text-nano rounded-md border transition-colors duration-100 max-md:min-h-11 max-md:px-2.5",
                            active
                              ? "bg-accent-muted text-accent-ink border-accent-line font-medium"
                              : "bg-surface text-ink-muted hover:text-ink hover:bg-surface-hover border-line",
                          )}
                        >
                          {chip.label}
                        </button>
                      );
                    })}
                  </div>
                  {catalog.length > 0 && (
                    <Select
                      size="sm"
                      aria-label="从可用模型列表中选择"
                      placeholder="从可用模型列表中选择"
                      value={
                        catalog.some((p) => p.shortLabel === draft.model)
                          ? (draft.model as string)
                          : NONE
                      }
                      onValueChange={(v) => {
                        if (v !== NONE) setDraft({ ...draft, model: v });
                      }}
                      options={[
                        { value: NONE, label: "从可用模型列表中选择", disabled: true },
                        ...catalog.map((p) => ({
                          value: p.shortLabel,
                          label: `${p.label} (${p.shortLabel})`,
                        })),
                      ]}
                    />
                  )}
                </div>
              </Field>
              <Field
                label="工具白名单"
                hint="对 Claude 生效；Codex 无法强制工具名单。逗号分隔，留空 = 不限制；配了技能会自动补 Skill"
              >
                <Input
                  value={draft.tools?.join(", ") ?? ""}
                  onChange={(e) => setDraft({ ...draft, tools: parseList(e.target.value) })}
                  className="font-mono"
                  placeholder="Read, Grep, Glob"
                />
              </Field>
            </div>

            <Field label="工具黑名单" hint="对 Claude 生效；Codex 无法强制。与白名单互不影响，可同时给">
              <Input
                value={draft.disallowedTools?.join(", ") ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, disallowedTools: parseList(e.target.value) })
                }
                className="font-mono"
                placeholder="Bash"
              />
            </Field>

            {/* 隔离开关 */}
            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox
                checked={draft.inheritEnv ?? false}
                onCheckedChange={(v) => setDraft({ ...draft, inheritEnv: v === true })}
                className="mt-0.5"
              />
              <span className="text-ui text-ink">
                继承本机环境
                <span className="block text-label text-ink-muted">
                  勾上 = 读当前 CLI 的项目说明、本机全部技能、MCP（适合干活型 Agent）。
                  不勾 = 隔离：<b>无项目说明、无环境技能、无 MCP</b>，只有下面选中的技能。
                  隔离的 Agent 可复现、能整包搬到别的机器。
                </span>
              </span>
            </label>

            {/* S89: permission / requireApproval */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="工具权限档位" hint="Agent 级默认。跟随会话 = 不覆盖。">
                <Select
                  aria-label="工具权限档位"
                  value={draft.permission ?? INHERIT}
                  onValueChange={(v) =>
                    setDraft({ ...draft, permission: v === INHERIT ? null : v })
                  }
                  options={PERMISSION_OPTIONS}
                />
              </Field>

              <Field
                label="逐个确认"
                hint={
                  "覆盖会话的「自动批准 / 需确认」设置（会话侧在新建时选），两者都设时以 Agent 为准。" +
                  "Claude / Codex 都支持逐项审批（Codex 的可信白名单命令会自动放行）。"
                }
              >
                <Select
                  aria-label="逐个确认"
                  value={
                    draft.requireApproval === null || draft.requireApproval === undefined
                      ? INHERIT
                      : draft.requireApproval
                        ? "yes"
                        : "no"
                  }
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      requireApproval: v === INHERIT ? null : v === "yes",
                    })
                  }
                  options={APPROVAL_OPTIONS}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer self-start">
              <Checkbox
                checked={draft.enabled ?? true}
                onCheckedChange={(v) => setDraft({ ...draft, enabled: v === true })}
              />
              <span className="text-ui text-ink">
                启用
                <span className="ml-1.5 text-label text-ink-muted">
                  停用后不在选择器里出现，老会话静默退回默认人设
                </span>
              </span>
            </label>

            {/* 挂载技能 */}
            <Field
              label={`挂载技能（已选 ${draft.skills?.length ?? 0}）`}
              hint="从本机 ~/.claude/skills/ 挂给这个 Agent。Claude 通过 Skill 工具加载；Codex 会内联 SKILL.md 并保留源目录供脚本 / 引用解析。改正文自动跟随，不用重新保存"
            >
              <Input
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
                leading={<Icon icon={Search} size="sm" />}
                wrapperClassName="mb-2"
                placeholder="搜索技能…"
                aria-label="搜索技能"
              />
              <div className="max-h-[220px] overflow-y-auto flex flex-wrap gap-1.5 p-2 rounded-card border border-line bg-surface-muted">
                {filteredSkills.map((s) => {
                  const on = draft.skills?.some((x) => x.name === s.dir) ?? false;
                  return (
                    <button
                      key={s.dir}
                      type="button"
                      aria-pressed={on}
                      title={s.description}
                      onClick={() => toggleSkill(s.dir)}
                      className={cn(
                        "px-2 py-0.5 rounded-full text-label border font-mono transition-colors duration-100 max-md:min-h-11",
                        on
                          ? "bg-accent text-accent-fg border-accent"
                          : "bg-surface text-ink-muted border-line hover:border-line-strong hover:text-ink",
                      )}
                    >
                      {s.dir}
                    </button>
                  );
                })}
                {!filteredSkills.length && (
                  <span className="text-label text-ink-faint">
                    {hostSkills.length ? "没有匹配的技能" : "本机还没有可挂载的技能"}
                  </span>
                )}
              </div>
            </Field>

            {/* 渠道绑定 / 飞书机器人接入 */}
            {selected && (
              <section className="rounded-card border border-line bg-surface p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-ui font-semibold text-ink-strong flex items-center gap-2">
                      <Icon icon={MessagesSquare} className="text-ink-muted" />
                      <span>飞书机器人接入</span>
                      <span className="text-label text-ink-faint tabular-nums">
                        {bots.filter((b) => b.agentId === selected.id).length}
                      </span>
                    </div>
                    <div className="text-label text-ink-muted mt-0.5">
                      接入飞书自建应用。飞书用户发消息时直接以该 Agent 的人设、模型与挂载技能作答。
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <Button type="button" size="sm" onClick={() => setCreateBotModalOpen(true)}>
                      <Icon icon={Plus} size="sm" />
                      接入飞书机器人
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <a
                        href={FEISHU_LAUNCHER_URL}
                        target="_blank"
                        rel="noreferrer"
                        title="打开飞书开放平台的一键创建模板"
                      >
                        <Icon icon={Zap} size="sm" />
                        飞书一键创建
                        <Icon icon={ArrowUpRight} size="sm" />
                      </a>
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        href={`/settings/bots?new=1&agentId=${encodeURIComponent(selected.id)}`}
                        title="打开完整机器人设置向导"
                      >
                        完整向导
                        <Icon icon={ArrowUpRight} size="sm" />
                      </Link>
                    </Button>
                  </div>
                </div>

                {/* 本机已发现应用一键接入（免输入 App ID / Secret） */}
                {discovered.filter((d) => d.boundAgentId !== selected.id).length > 0 && (
                  <div className="rounded-card border border-accent-line bg-accent-muted p-3 flex flex-col gap-2">
                    <div className="text-ui font-medium text-ink flex items-center gap-1.5">
                      <Icon icon={Sparkles} size="sm" className="text-accent-ink" />
                      检测到本机已配置的飞书应用（免复制凭证，一键接入并绑定）
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {discovered
                        .filter((d) => d.boundAgentId !== selected.id)
                        .map((disc) => (
                          <div
                            key={disc.appId}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-card border border-line bg-surface"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 font-medium text-ui text-ink truncate">
                                <Icon icon={Bot} size="sm" className="text-ink-muted" />
                                {disc.name}
                              </div>
                              <div className="text-nano font-mono text-ink-faint truncate">
                                {disc.appId} · {disc.source}
                              </div>
                              {disc.alreadyRegistered && disc.boundAgentName && (
                                <div className="text-nano text-ink-faint truncate">
                                  当前绑定于 @{disc.boundAgentSlug}
                                </div>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="shrink-0"
                              loading={botBusy === `import-${disc.appId}`}
                              onClick={() => void importDiscovered(disc)}
                            >
                              一键接入
                            </Button>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {(() => {
                  const boundBots = bots.filter((b) => b.agentId === selected.id);
                  const otherBots = bots.filter((b) => b.agentId !== selected.id);
                  const bindPicker = otherBots.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Select
                        size="sm"
                        aria-label="选择已有机器人绑定"
                        className="min-w-[14rem] flex-1"
                        value={botToBind}
                        onValueChange={setBotToBind}
                        options={[
                          { value: NONE, label: "选择已有机器人绑定", disabled: true },
                          ...otherBots.map((b) => ({
                            value: b.id,
                            label: `${b.botName || b.name} (${b.appId})`,
                          })),
                        ]}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={botToBind === NONE || botBusy !== null}
                        loading={botBusy === botToBind}
                        onClick={() => void bindBot(botToBind)}
                      >
                        绑定到此 Agent
                      </Button>
                    </div>
                  );

                  return (
                    <div className="flex flex-col gap-3">
                      {boundBots.length === 0 ? (
                        <div className="rounded-card border border-dashed border-line px-4 py-4 flex flex-col items-center gap-2.5 text-ui text-ink-muted">
                          <div>这个 Agent 还没有绑定飞书机器人。</div>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setCreateBotModalOpen(true)}
                            >
                              <Icon icon={Plus} size="sm" />
                              手动录入并绑定
                            </Button>
                            {bindPicker}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="rounded-card border border-line divide-y divide-line-faint">
                            {boundBots.map((bot) => (
                              <div
                                key={bot.id}
                                className="flex items-center justify-between gap-3 px-3 py-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-ui text-ink truncate">
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
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button asChild variant="ghost" size="sm">
                                    <Link href={`/settings/bots?id=${encodeURIComponent(bot.id)}`}>
                                      配置
                                      <Icon icon={ArrowUpRight} size="sm" />
                                    </Link>
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    loading={botBusy === bot.id}
                                    onClick={() => void unbindBot(bot)}
                                  >
                                    解绑
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                          {bindPicker && <div className="pt-1">{bindPicker}</div>}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </section>
            )}

            <div className="flex items-center gap-2 pt-3 border-t border-line">
              <Button
                type="button"
                variant="primary"
                onClick={() => void save()}
                loading={saving}
                disabled={!draft.slug.trim() || !draft.name.trim()}
              >
                {selectedId ? "保存" : "创建"}
              </Button>
              {!selectedId && (
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  取消
                </Button>
              )}
              {selected && !selected.builtin && (
                <Button
                  type="button"
                  variant="danger"
                  className="ml-auto"
                  onClick={() => void deleteAgent()}
                >
                  <Icon icon={Trash2} />
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
      )}

      {selected && createBotModalOpen && (
        <QuickCreateBotModal
          agent={selected}
          discovered={discovered.filter((d) => d.boundAgentId !== selected.id)}
          onClose={() => setCreateBotModalOpen(false)}
          onSuccess={async (botName) => {
            await refreshBots();
            toast.success(`已接入「${botName}」`, {
              description: `飞书机器人已绑定到 Agent「${selected.name}」。`,
            });
          }}
        />
      )}
    </div>
  );
}

function QuickCreateBotModal({
  agent,
  discovered,
  onClose,
  onSuccess,
}: {
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
  const [error, setError] = useState<unknown>(null);

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
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !appId.trim() || !appSecret.trim()) {
      setError(new Error("请填写应用名称、App ID 和 App Secret"));
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
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="接入飞书机器人">
      <div className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-semibold text-ink-strong">接入飞书机器人</h2>
            <p className="text-label text-ink-muted mt-0.5">
              绑定执行人设：<span className="font-medium text-ink">{agent.name}</span> (@{agent.slug})
            </p>
          </div>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>

        {error !== null && <ErrorCallout compact error={error} title="接入没有成功" />}

        {/* 快捷 Launcher 引导 */}
        <div className="rounded-card border border-line bg-surface-muted p-2.5 flex flex-wrap items-center justify-between gap-2 text-label">
          <span className="text-ink-muted">还没有创建飞书应用？可以用官方模板一键生成：</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button asChild size="sm">
              <a href={FEISHU_LAUNCHER_URL} target="_blank" rel="noreferrer">
                <Icon icon={Zap} size="sm" />
                飞书一键创建
                <Icon icon={ArrowUpRight} size="sm" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={LARK_LAUNCHER_URL} target="_blank" rel="noreferrer">
                Lark 国际版
                <Icon icon={ArrowUpRight} size="sm" />
              </a>
            </Button>
          </div>
        </div>

        {/* 发现的本地应用免复制区 */}
        {discovered.length > 0 && (
          <div className="rounded-card border border-accent-line bg-accent-muted p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-label font-medium text-ink">
              <Icon icon={Sparkles} size="sm" className="text-accent-ink" />
              从本机已发现的应用一键接入（免填写凭证）
            </div>
            <div className="flex flex-col gap-1.5">
              {discovered.map((disc) => (
                <div
                  key={disc.appId}
                  className="flex items-center justify-between gap-2 p-2 rounded-field bg-surface border border-line"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium text-ui truncate text-ink">
                      <Icon icon={Bot} size="sm" className="text-ink-muted" />
                      {disc.name}
                    </div>
                    <div className="text-nano font-mono text-ink-faint truncate">
                      {disc.appId} · {disc.source}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="shrink-0"
                    disabled={busy}
                    onClick={() => void handleImportDisc(disc)}
                  >
                    一键接入
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="text-label text-ink-muted font-medium pt-1">或手动输入凭证接入</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="配置名称" hint="例如：研发助手">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：苏格拉底导师"
                required
              />
            </Field>
            <Field label="飞书 App ID" hint="开放平台里 cli_ 开头的标识">
              <Input
                className="font-mono"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                required
              />
            </Field>
          </div>

          <Field label="飞书 App Secret" hint="在开放平台「凭证与基础信息」中复制">
            <Input
              className="font-mono"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="请输入 App Secret"
              required
            />
          </Field>

          <Field label="工作目录（选填）" hint="留空使用聊天工作区；填写后以项目模式在该目录执行">
            <Input
              className="font-mono"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="/absolute/path/to/project"
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-line mt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !appId.trim() || !appSecret.trim()}
            >
              测试并接入
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function BotStatusBadge({ bot }: { bot: LarkBot }) {
  const text = !bot.enabled ? "已停用" : bot.lastError ? "异常" : bot.lastConnectedAt ? "已连接" : "待连接";
  const variant = bot.lastError
    ? "danger"
    : bot.lastConnectedAt && bot.enabled
      ? "positive"
      : "neutral";
  return <Badge variant={variant}>{text}</Badge>;
}

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
    <div className="flex flex-col gap-1">
      <div className="text-ui font-medium text-ink">{label}</div>
      {hint && <div className="text-label text-ink-muted">{hint}</div>}
      <div className="mt-0.5">{children}</div>
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
