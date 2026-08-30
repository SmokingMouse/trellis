"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LarkBot, LarkBotInput } from "@/lib/lark-types";

type AgentOption = { id: string; name: string; slug: string };
type Draft = Required<Pick<LarkBotInput, "name" | "appId">> & {
  appSecret: string;
  agentId: string | null;
  workspacePath: string;
  enabled: boolean;
};

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

const EMPTY: Draft = {
  name: "",
  appId: "",
  appSecret: "",
  agentId: null,
  workspacePath: "",
  enabled: true,
};

const FEISHU_LAUNCHER_URL = "https://open.feishu.cn/page/launcher?from=backend_oneclick";
const LARK_LAUNCHER_URL = "https://open.larkoffice.com/page/launcher?from=backend_oneclick";

export default function LarkBotsSettingsPage() {
  const [bots, setBots] = useState<LarkBot[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredBot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | "one-click" | string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 一键创建向导中的 Agent 模式：选择已有 vs 就地新建
  const [agentMode, setAgentMode] = useState<"existing" | "new">("existing");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentSlug, setNewAgentSlug] = useState("");
  const [newAgentDesc, setNewAgentDesc] = useState("");
  const [newAgentPrompt, setNewAgentPrompt] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [botRes, discRes] = await Promise.allSettled([
        fetch("/api/lark-bots", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/lark-bots/discover", { cache: "no-store" }).then((r) => r.json()),
      ]);

      if (botRes.status === "fulfilled" && botRes.value.bots) {
        setBots(botRes.value.bots);
      }
      if (discRes.status === "fulfilled" && discRes.value.discovered) {
        setDiscovered(discRes.value.discovered);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch {
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    void refreshAgents();
    const timer = setInterval(() => void refresh(true), 5_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh, refreshAgents]);

  // 处理 URL query params（如 ?new=1&agentId=xxx 或 ?id=xxx）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new") === "1";
    const agentIdParam = params.get("agentId");
    const idParam = params.get("id");

    if (newParam) {
      setSelectedId(null);
      setDraft({
        ...EMPTY,
        agentId: agentIdParam || null,
      });
      setAgentMode("existing");
    } else if (idParam) {
      setSelectedId(idParam);
    }
  }, []);

  // 当外部指定 id 或列表初次加载时回填草稿
  useEffect(() => {
    if (selectedId && !draft && bots.length > 0) {
      const bot = bots.find((b) => b.id === selectedId);
      if (bot) {
        setDraft({
          name: bot.name,
          appId: bot.appId,
          appSecret: "",
          agentId: bot.agentId,
          workspacePath: bot.workspacePath ?? "",
          enabled: bot.enabled,
        });
      }
    }
  }, [selectedId, draft, bots]);

  const selected = bots.find((bot) => bot.id === selectedId) ?? null;

  const edit = (bot: LarkBot) => {
    setSelectedId(bot.id);
    setDraft({
      name: bot.name,
      appId: bot.appId,
      appSecret: "",
      agentId: bot.agentId,
      workspacePath: bot.workspacePath ?? "",
      enabled: bot.enabled,
    });
    setMessage(null);
    setError(null);
  };

  const create = (defaultAgentId?: string | null) => {
    setSelectedId(null);
    setDraft({
      ...EMPTY,
      agentId: defaultAgentId ?? null,
    });
    setAgentMode("existing");
    setNewAgentName("");
    setNewAgentSlug("");
    setNewAgentDesc("");
    setNewAgentPrompt("");
    setNewAgentModel("");
    setMessage(null);
    setError(null);
  };

  const request = async (url: string, init: RequestInit) => {
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  };

  // 一键导入本机已发现的凭证并接入绑定（免复制 App ID / Secret）
  const handleImportDiscovered = async (disc: DiscoveredBot, customAgentId?: string | null) => {
    setBusy(`import-${disc.appId}`);
    setMessage(null);
    setError(null);
    try {
      const data = await request("/api/lark-bots/import-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: disc.appId,
          name: disc.name,
          agentId: customAgentId !== undefined ? customAgentId : draft?.agentId ?? null,
        }),
      });

      setSelectedId(data.bot.id);
      setDraft({
        name: data.bot.name,
        appId: data.bot.appId,
        appSecret: "",
        agentId: data.bot.agentId,
        workspacePath: data.bot.workspacePath ?? "",
        enabled: data.bot.enabled,
      });

      const agentName = agents.find((a) => a.id === data.bot.agentId)?.name || "默认助手";
      setMessage(
        `🎉 成功从本机（${disc.source}）一键导入并连接飞书应用「${data.testedName || data.bot.name}」！已自动绑定到「${agentName}」。长连接将在 15 秒内就绪。`,
      );
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // 手动表单的一键接入
  const handleOneClickSetup = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.appId.trim() || !draft.appSecret.trim()) {
      setError("请填写配置名称、飞书 App ID 和 App Secret");
      return;
    }

    setBusy("one-click");
    setMessage(null);
    setError(null);

    try {
      let targetAgentId = draft.agentId;

      // 1. 如果选择了就地新建 Agent，先创建 Agent
      if (agentMode === "new") {
        if (!newAgentName.trim() || !newAgentSlug.trim()) {
          throw new Error("请填写新 Agent 的名称与 slug");
        }
        const agentRes = await request("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newAgentName.trim(),
            slug: newAgentSlug.trim(),
            description: newAgentDesc.trim(),
            systemPrompt: newAgentPrompt.trim(),
            model: newAgentModel.trim() || null,
            inheritEnv: true,
            enabled: true,
          }),
        });
        targetAgentId = agentRes.agent.id;
        await refreshAgents();
      }

      // 2. 创建飞书机器人
      const botPayload = {
        name: draft.name.trim(),
        appId: draft.appId.trim(),
        appSecret: draft.appSecret.trim(),
        agentId: targetAgentId,
        workspacePath: draft.workspacePath.trim() || null,
        enabled: draft.enabled,
      };
      const botRes = await request("/api/lark-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botPayload),
      });

      const newBotId = botRes.bot.id;

      // 3. 自动测试凭证连通性
      let testMessage = "";
      try {
        const testRes = await request(`/api/lark-bots/${newBotId}/test`, { method: "POST" });
        testMessage = `凭证测试成功：已连接飞书应用「${testRes.bot.name}」(${testRes.bot.openId})`;
      } catch (testErr) {
        testMessage = `机器人已保存，但凭证测试未通过：${testErr instanceof Error ? testErr.message : String(testErr)}（请检查 App Secret 或应用发布状态）`;
      }

      setSelectedId(newBotId);
      setDraft({
        name: botRes.bot.name,
        appId: botRes.bot.appId,
        appSecret: "",
        agentId: botRes.bot.agentId,
        workspacePath: botRes.bot.workspacePath ?? "",
        enabled: botRes.bot.enabled,
      });
      setMessage(`🎉 飞书机器人接入成功！${testMessage}。服务端长连接将在 15 秒内就绪。`);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setMessage(null);
    setError(null);
    try {
      const payload = {
        name: draft.name,
        appId: draft.appId,
        appSecret: draft.appSecret,
        agentId: draft.agentId,
        workspacePath: draft.workspacePath || null,
        enabled: draft.enabled,
      };
      const data = await request(
        selectedId ? `/api/lark-bots/${selectedId}` : "/api/lark-bots",
        {
          method: selectedId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      setSelectedId(data.bot.id);
      setDraft((current) => current ? { ...current, appSecret: "" } : current);
      setMessage("已保存；连接配置会在 15 秒内由后台对账生效。");
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!selectedId) return;
    setBusy("test");
    setMessage(null);
    setError(null);
    try {
      const data = await request(`/api/lark-bots/${selectedId}/test`, { method: "POST" });
      setMessage(`凭证可用：${data.bot.name}（${data.bot.openId}）`);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selected || !confirm(`删除机器人「${selected.name}」？已生成的 Trellis 会话会保留。`)) return;
    setBusy("delete");
    try {
      await request(`/api/lark-bots/${selected.id}`, { method: "DELETE" });
      setSelectedId(null);
      setDraft(null);
      setMessage("机器人配置已删除，后台将在 15 秒内断开连接。");
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const boundAgent = agents.find((a) => a.id === draft?.agentId) ?? null;

  return (
    <div className="flex flex-col md:flex-row gap-4">
      {/* 左侧：机器人列表与新建入口 */}
      <aside className="md:w-[280px] shrink-0 flex flex-col gap-2">
        <Button type="button" variant="primary" size="sm" onClick={() => create()}>
          + 接入飞书机器人
        </Button>
        <div className="text-label text-ink-faint px-1">
          保存后由服务端长连接接收消息，无需公网 webhook。
        </div>
        {loading && <div className="text-ui text-ink-faint">加载中…</div>}
        {bots.map((bot) => {
          const botAgent = agents.find((a) => a.id === bot.agentId);
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => edit(bot)}
              className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                selectedId === bot.id
                  ? "bg-accent text-ink-inverse border-accent"
                  : "bg-surface border-line hover:border-line-strong"
              } ${bot.enabled ? "" : "opacity-55"}`}
            >
              <div className="flex items-center gap-2 text-ui font-medium">
                <span className="truncate">{bot.botName || bot.name}</span>
                <StatusBadge bot={bot} selected={selectedId === bot.id} />
              </div>
              <div className={`text-label font-mono truncate ${selectedId === bot.id ? "opacity-75" : "text-ink-faint"}`}>
                {bot.appId}
              </div>
              {botAgent ? (
                <div className={`text-nano truncate mt-0.5 ${selectedId === bot.id ? "opacity-90" : "text-accent-ink"}`}>
                  🎭 {botAgent.name}
                </div>
              ) : (
                <div className={`text-nano truncate mt-0.5 ${selectedId === bot.id ? "opacity-70" : "text-ink-faint"}`}>
                  默认助手
                </div>
              )}
            </button>
          );
        })}
        {!loading && bots.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-5 text-ui text-ink-faint text-center">
            尚未接入机器人。
          </div>
        )}
      </aside>

      {/* 右侧：发现区 + 向导式创建 / 编辑面板 */}
      <main className="flex-1 min-w-0 space-y-4">
        {/* 本机已发现应用推荐区（无需复制 App ID / Secret） */}
        {discovered.length > 0 && (
          <section className="rounded-xl border border-accent-line bg-accent-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden>✨</span>
                <span className="font-semibold text-ui text-ink">
                  检测到本机已配置的飞书应用（一键直连，无需复制 App ID / Secret）
                </span>
              </div>
              <span className="text-label text-ink-faint">
                来源：~/.feishu-cli / 环境变量
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {discovered.map((disc) => {
                const isImporting = busy === `import-${disc.appId}`;
                return (
                  <div
                    key={disc.appId}
                    className="flex flex-col justify-between p-3 rounded-lg border border-line bg-surface gap-2.5 shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-ui truncate text-ink">
                          🤖 {disc.name}
                        </span>
                        {disc.online ? (
                          <span className="px-1.5 py-0.2 rounded-full text-nano bg-accent-muted text-accent-ink border border-accent-line shrink-0">
                            在线可用
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.2 rounded-full text-nano bg-danger-muted text-danger-ink shrink-0">
                            离线
                          </span>
                        )}
                      </div>
                      <div className="text-label font-mono text-ink-faint truncate mt-0.5">
                        {disc.appId}
                      </div>
                      <div className="text-nano text-ink-faint truncate mt-0.5">
                        来源: {disc.source}
                        {disc.alreadyRegistered && disc.boundAgentName && (
                          <span className="text-accent-ink ml-1 font-sans">
                            · 绑定于 @{disc.boundAgentSlug}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-1 border-t border-line">
                      {disc.alreadyRegistered && disc.registeredBotId ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="w-full text-xs"
                          onClick={() => {
                            const found = bots.find((b) => b.id === disc.registeredBotId);
                            if (found) edit(found);
                          }}
                        >
                          已接入（点击查看/编辑） ↗
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          className="w-full text-xs"
                          disabled={isImporting}
                          onClick={() => void handleImportDiscovered(disc)}
                        >
                          {isImporting ? "正在接入…" : "⚡ 一键接入并连接"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {error && <div className="px-3 py-2 rounded-lg border border-danger-line bg-danger-muted text-danger-ink text-ui">{error}</div>}
        {message && <div className="px-3 py-2 rounded-lg border border-line bg-surface-muted text-ui text-ink-muted leading-relaxed">{message}</div>}

        {!draft ? (
          <div className="py-8 text-ui text-ink-faint text-center">
            {discovered.length === 0
              ? "左边选一个机器人编辑，或点击上方接入新应用。"
              : "可在上方直接一键接入本机发现的应用，或在左侧编辑已接入的机器人。"}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* 指南卡片与一键创建链接 */}
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
                <div>
                  <div className="text-ui font-semibold flex items-center gap-2">
                    <span>🚀 飞书 / Lark 应用一键极速创建与接入</span>
                  </div>
                  <div className="text-label text-ink-muted mt-1 leading-relaxed space-y-1">
                    <div>1. 点击右侧 <b>「⚡ 飞书一键创建应用 (Launcher)」</b> 直达预置模板快速生成自建应用；</div>
                    <div>2. 模板已预配好机器人与长连接事件，创建后将自动生成的 <b>App ID</b> 和 <b>App Secret</b> 填入下方；</div>
                    <div>3. 若本机已安装并登录 <code className="px-1 py-0.5 bg-surface-muted rounded font-mono text-nano">feishu-cli</code>，上方卡片会<b>自动探测识别</b>，直接点击一键接入即可。</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <a
                    href={FEISHU_LAUNCHER_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 text-label rounded-md bg-accent text-ink-inverse hover:bg-accent-strong transition-colors font-medium"
                    title="在飞书开放平台通过官方 Launcher 模板一键创建机器人应用"
                  >
                    ⚡ 飞书一键创建 (Launcher) ↗
                  </a>
                  <a
                    href={LARK_LAUNCHER_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 text-label rounded-md border border-line hover:border-line-strong text-ink hover:text-ink-strong transition-colors"
                    title="在 Lark 国际版通过官方 Launcher 模板一键创建机器人应用"
                  >
                    Lark 国际版 ↗
                  </a>
                </div>
              </div>
            </div>

            {/* 1. 基础与凭证信息 */}
            <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="text-ui font-semibold">1. 应用与凭证信息</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="配置名称" hint="在 Trellis 中显示的易记名称">
                  <input className={INPUT} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：代码评审专家" />
                </Field>
                <Field label="飞书 App ID" hint="开放平台 cli_ 开头的唯一标识">
                  <input className={`${INPUT} font-mono`} value={draft.appId} onChange={(e) => setDraft({ ...draft, appId: e.target.value })} placeholder="cli_xxxxxxxxxxxxxxxx" autoComplete="off" />
                </Field>
              </div>

              <Field
                label="飞书 App Secret"
                hint={selected?.hasSecret ? "已保存安全凭证。留空表示不修改；服务端永不回显。" : "在开放平台复制，或直接从上方本机发现中一键接入免填。"}
              >
                <input className={`${INPUT} font-mono`} type="password" value={draft.appSecret} onChange={(e) => setDraft({ ...draft, appSecret: e.target.value })} placeholder={selected ? "留空不改" : "请输入 app_secret"} autoComplete="new-password" />
              </Field>
            </section>

            {/* 2. 绑定 Agent 策略（Agent-first 体验） */}
            <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-ui font-semibold">2. 绑定执行 Agent（人设、技能与工具）</div>
                  <div className="text-label text-ink-faint mt-0.5">飞书用户发消息时，将以该 Agent 的专属提示词、挂载技能与模型运行。</div>
                </div>
                {!selected && (
                  <div className="flex rounded-lg border border-line p-0.5 bg-surface-muted text-label">
                    <button
                      type="button"
                      onClick={() => setAgentMode("existing")}
                      className={`px-2 py-0.5 rounded transition-colors ${agentMode === "existing" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
                    >
                      选择已有 Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentMode("new")}
                      className={`px-2 py-0.5 rounded transition-colors ${agentMode === "new" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
                    >
                      就地新建 Agent
                    </button>
                  </div>
                )}
              </div>

              {agentMode === "existing" || selected ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <select
                      className={`${INPUT} flex-1`}
                      value={draft.agentId ?? ""}
                      onChange={(e) => setDraft({ ...draft, agentId: e.target.value || null })}
                    >
                      <option value="">默认助手（不附加自定义人设）</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} (@{agent.slug})
                        </option>
                      ))}
                    </select>
                    {!selected && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setAgentMode("new")}
                      >
                        + 新建 Agent
                      </Button>
                    )}
                  </div>
                  {boundAgent && (
                    <div className="flex items-center gap-1.5 text-label">
                      <span className="text-ink-faint">当前绑定人设：</span>
                      <span className="text-ink font-medium">{boundAgent.name}</span>
                      <Link
                        href={`/settings/agents?id=${encodeURIComponent(boundAgent.id)}`}
                        className="text-accent-ink hover:underline ml-1"
                      >
                        查看 / 编辑人设 ↗
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                /* 就地新建 Agent 表单 */
                <div className="p-3 rounded-lg border border-line bg-surface-muted space-y-3">
                  <div className="text-label text-ink-muted font-medium">✨ 在此处定义新人设，创建后自动与该机器人绑定：</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Agent 名字" hint="例如：技术支持">
                      <input
                        className={INPUT}
                        value={newAgentName}
                        onChange={(e) => {
                          setNewAgentName(e.target.value);
                          if (!newAgentSlug) {
                            const s = e.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, "-")
                              .replace(/^-|-$/g, "");
                            if (s) setNewAgentSlug(s);
                          }
                        }}
                        placeholder="例如：代码审查专家"
                      />
                    </Field>
                    <Field label="slug" hint="英文/数字/连字符，≤32字符">
                      <input
                        className={`${INPUT} font-mono`}
                        value={newAgentSlug}
                        onChange={(e) => setNewAgentSlug(e.target.value)}
                        placeholder="code-reviewer"
                      />
                    </Field>
                  </div>
                  <Field label="一句话职责自述">
                    <input
                      className={INPUT}
                      value={newAgentDesc}
                      onChange={(e) => setNewAgentDesc(e.target.value)}
                      placeholder="例如：专注代码架构与潜在缺陷审查"
                    />
                  </Field>
                  <Field label="系统提示词（人设 Prompt）">
                    <textarea
                      className={`${INPUT} resize-y font-mono text-ui`}
                      rows={3}
                      value={newAgentPrompt}
                      onChange={(e) => setNewAgentPrompt(e.target.value)}
                      placeholder="你是飞书助手，主要职责是..."
                    />
                  </Field>
                  <Field label="指定模型" hint="留空跟随会话默认模型">
                    <input
                      className={`${INPUT} font-mono`}
                      value={newAgentModel}
                      onChange={(e) => setNewAgentModel(e.target.value)}
                      placeholder="haiku / sonnet / opus / codex（留空默认）"
                    />
                  </Field>
                </div>
              )}
            </section>

            {/* 3. 运行选项与工作目录 */}
            <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="text-ui font-semibold">3. 运行目录与连接控制</div>
              <Field label="工作目录（选填）" hint="留空使用通用聊天工作区；填写绝对路径后，机器人将以 project 模式在该目录执行与读写文件">
                <input className={`${INPUT} font-mono`} value={draft.workspacePath} onChange={(e) => setDraft({ ...draft, workspacePath: e.target.value })} placeholder="/absolute/path/to/project" />
              </Field>

              <label className="flex items-start gap-2 cursor-pointer rounded-lg border border-line bg-surface-muted px-3 py-2.5">
                <input className="mt-1" type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                <span className="text-ui">
                  启用长连接监听
                  <span className="block text-label text-ink-faint">保存或修改凭证后无需重启 Trellis；后台每 15 秒自动对账并保持长连接。</span>
                </span>
              </label>
            </section>

            {/* 连接状态与会话明细（编辑模式） */}
            {selected && (
              <section className="rounded-xl border border-line bg-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-line flex items-center gap-2">
                  <div className="font-medium text-ui">连接状态</div>
                  <StatusBadge bot={selected} />
                  <span className="ml-auto text-label text-ink-faint">
                    {selected.lastConnectedAt ? `最近连接 ${new Date(selected.lastConnectedAt).toLocaleString()}` : "尚未连接"}
                  </span>
                </div>
                {selected.lastError && <div className="px-4 py-2.5 text-label text-danger-ink bg-danger-muted">{selected.lastError}</div>}
                <div className="px-4 py-3">
                  <div className="text-ui font-medium mb-2">飞书会话（最近）</div>
                  <div className="flex flex-col gap-1.5">
                    {selected.chats.length === 0 && <div className="text-label text-ink-faint">还没有收到消息。在飞书里向机器人发一条私聊开始对话。</div>}
                    {selected.chats.map((chat) => (
                      <a
                        key={chat.id}
                        href={chat.sessionId ? `/?session=${encodeURIComponent(chat.sessionId)}&node=${encodeURIComponent(chat.lastNodeId || "")}` : undefined}
                        aria-disabled={!chat.sessionId}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg border border-line bg-surface-muted hover:border-line-strong aria-disabled:opacity-50"
                      >
                        <span aria-hidden>{chat.chatType === "group" ? "👥" : "👤"}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-ui truncate">{chat.title || chat.chatId}</span>
                          <span className="block text-label text-ink-faint font-mono truncate">{chat.chatId}</span>
                        </span>
                        <span className="text-label text-ink-faint shrink-0">
                          {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleString() : ""}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* 提交动作栏 */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
              {!selected ? (
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  onClick={() => void handleOneClickSetup()}
                  disabled={busy !== null || !draft.name.trim() || !draft.appId.trim() || !draft.appSecret.trim()}
                >
                  {busy === "one-click" ? "正在测试并创建接入…" : "⚡ 测试凭证并接入绑定"}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void save()}
                    disabled={busy !== null || !draft.name.trim() || !draft.appId.trim()}
                  >
                    {busy === "save" ? "保存中…" : "保存变更"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void test()}
                    disabled={busy !== null}
                  >
                    {busy === "test" ? "测试中…" : "测试凭证"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove()}
                    disabled={busy !== null}
                  >
                    {busy === "delete" ? "删除中…" : "删除"}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ bot, selected = false }: { bot: LarkBot; selected?: boolean }) {
  const text = !bot.enabled ? "已停用" : bot.lastError ? "异常" : bot.lastConnectedAt ? "已连接" : "待连接";
  const tone = selected
    ? "bg-white/15 text-current border-white/20"
    : bot.lastError
      ? "bg-danger-muted text-danger-ink border-danger-line"
      : bot.lastConnectedAt && bot.enabled
        ? "bg-accent-muted text-accent-ink border-accent-line"
        : "bg-surface-muted text-ink-faint border-line";
  return <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full border text-nano ${tone}`}>{text}</span>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div><div className="text-ui font-medium mb-1">{label}</div>{hint && <div className="text-label text-ink-faint mb-1">{hint}</div>}{children}</div>;
}

const INPUT = "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";
