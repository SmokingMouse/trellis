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

const EMPTY: Draft = {
  name: "",
  appId: "",
  appSecret: "",
  agentId: null,
  workspacePath: "",
  enabled: true,
};

export default function LarkBotsSettingsPage() {
  const [bots, setBots] = useState<LarkBot[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/lark-bots", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "加载失败");
      setBots(data.bots ?? []);
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
    // manager 的产品语义是 15 秒对账；页面短轮询让状态徽标无需手动刷新。
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
    setMessage(null);
    setError(null);
  };

  const request = async (url: string, init: RequestInit) => {
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
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
      <aside className="md:w-[280px] shrink-0 flex flex-col gap-2">
        <Button type="button" variant="primary" size="sm" onClick={() => create()}>
          + 登记飞书机器人
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
              {botAgent && (
                <div className={`text-nano truncate mt-0.5 ${selectedId === bot.id ? "opacity-90" : "text-accent-ink"}`}>
                  🎭 {botAgent.name}
                </div>
              )}
            </button>
          );
        })}
        {!loading && bots.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-5 text-ui text-ink-faint">
            还没有机器人。先在飞书开放平台创建自建应用并开启机器人能力。
          </div>
        )}
      </aside>

      <main className="flex-1 min-w-0">
        {!draft ? (
          <div className="py-8 text-ui text-ink-faint">左边选一个机器人编辑，或登记新应用。</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-line bg-surface px-4 py-3">
              <div className="text-ui font-semibold">连接与身份</div>
              <div className="text-label text-ink-faint mt-1">
                P2P 消息直接触发；群聊只有明确 @bot 才触发。每个飞书 chat 会生成一条可分叉的 Trellis 会话。
              </div>
            </div>

            {error && <div className="px-3 py-2 rounded-lg border border-danger-line bg-danger-muted text-danger-ink text-ui">{error}</div>}
            {message && <div className="px-3 py-2 rounded-lg border border-line bg-surface-muted text-ui text-ink-muted">{message}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="配置名称" hint="只在 Trellis 设置页显示">
                <input className={INPUT} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：研发助手" />
              </Field>
              <Field label="飞书 app_id">
                <input className={`${INPUT} font-mono`} value={draft.appId} onChange={(e) => setDraft({ ...draft, appId: e.target.value })} placeholder="cli_xxxxxxxxxxxxxxxx" autoComplete="off" />
              </Field>
            </div>

            <Field
              label="飞书 app_secret"
              hint={selected?.hasSecret ? "已保存。留空表示不修改；服务端永不回显原值。" : "只在服务端 DB 保存，提交后不再回显。"}
            >
              <input className={`${INPUT} font-mono`} type="password" value={draft.appSecret} onChange={(e) => setDraft({ ...draft, appSecret: e.target.value })} placeholder={selected ? "留空不改" : "请输入 app_secret"} autoComplete="new-password" />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="绑定 Agent" hint="绑定专属 Agent 人设、技能与工具策略">
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
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setCreateAgentOpen(true)}
                    title="新建自定义 Agent 并自动绑定"
                  >
                    + 新建 Agent
                  </Button>
                </div>
                {boundAgent && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-label">
                    <span className="text-ink-faint">当前人设：</span>
                    <span className="text-ink font-medium">{boundAgent.name}</span>
                    <Link
                      href={`/settings/agents?id=${encodeURIComponent(boundAgent.id)}`}
                      className="text-accent-ink hover:underline ml-1"
                    >
                      查看人设 ↗
                    </Link>
                  </div>
                )}
              </Field>
              <Field label="工作目录" hint="留空使用聊天工作区；填写后以 project 模式在该目录运行">
                <input className={`${INPUT} font-mono`} value={draft.workspacePath} onChange={(e) => setDraft({ ...draft, workspacePath: e.target.value })} placeholder="/absolute/path/to/project" />
              </Field>
            </div>

            <label className="flex items-start gap-2 cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5">
              <input className="mt-1" type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              <span className="text-ui">
                启用长连接
                <span className="block text-label text-ink-faint">停用或改凭证后无需重启；后台每 15 秒对账一次。</span>
              </span>
            </label>

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
                  <div className="text-ui font-medium mb-2">飞书会话</div>
                  <div className="flex flex-col gap-1.5">
                    {selected.chats.length === 0 && <div className="text-label text-ink-faint">还没有收到消息</div>}
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

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
              <Button type="button" variant="primary" size="sm" onClick={() => void save()} disabled={busy !== null || !draft.name.trim() || !draft.appId.trim() || (!selected && !draft.appSecret.trim())}>
                {busy === "save" ? "保存中…" : selected ? "保存" : "创建"}
              </Button>
              {selected && <Button type="button" variant="ghost" size="sm" onClick={() => void test()} disabled={busy !== null}>{busy === "test" ? "测试中…" : "测试凭证"}</Button>}
              {selected && <Button type="button" variant="ghost" size="sm" onClick={() => void remove()} disabled={busy !== null}>{busy === "delete" ? "删除中…" : "删除"}</Button>}
            </div>
          </div>
        )}
      </main>

      <QuickCreateAgentModal
        open={createAgentOpen}
        onClose={() => setCreateAgentOpen(false)}
        onCreated={(agent) => {
          setAgents((prev) => [...prev.filter((a) => a.id !== agent.id), agent]);
          setDraft((prev) => (prev ? { ...prev, agentId: agent.id } : prev));
          setMessage(`已创建 Agent「${agent.name}」并自动绑定到此机器人。`);
        }}
      />
    </div>
  );
}

function QuickCreateAgentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: AgentOption) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) {
      setError("名字和 slug 不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          model: model.trim() || null,
          inheritEnv: true,
          enabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      onCreated({ id: data.agent.id, name: data.agent.name, slug: data.agent.slug });
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
            <h2 className="text-ui font-semibold">新建 Agent 并绑定</h2>
            <p className="text-label text-ink-faint mt-0.5">
              创建后将自动选定为此飞书机器人的执行人设
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

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Agent 名字" hint="显示名称，如：技术支持">
              <input
                className={INPUT}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slug) {
                    const s = e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-|-$/g, "");
                    if (s) setSlug(s);
                  }
                }}
                placeholder="例如：技术支持"
                required
              />
            </Field>
            <Field label="slug" hint="英文/数字/连字符，≤32字符">
              <input
                className={`${INPUT} font-mono`}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="tech-support"
                required
              />
            </Field>
          </div>

          <Field label="一句话说明" hint="Agent 职责说明">
            <input
              className={INPUT}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如：解答日常技术支持与架构问题"
            />
          </Field>

          <Field label="系统提示词" hint="定义 Agent 的角色人设和回答风格">
            <textarea
              className={`${INPUT} resize-y font-mono text-ui`}
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="你是飞书技术支持助手..."
            />
          </Field>

          <Field label="指定模型" hint="留空跟随默认会话模型">
            <input
              className={`${INPUT} font-mono`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="haiku / sonnet / opus / codex（留空默认）"
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-line mt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim() || !slug.trim()}>
              {busy ? "创建中…" : "创建并绑定"}
            </Button>
          </div>
        </form>
      </div>
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
