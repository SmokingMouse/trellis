"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  Lightbulb,
  MessagesSquare,
  QrCode,
  RefreshCw,
  Settings2,
  Sparkles,
  TriangleAlert,
  User,
  Users,
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
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  cn,
  toast,
  useConfirm,
} from "@/components/ui";
import {
  LARK_POLICY_DEFAULTS,
  type LarkAckMode,
  type LarkAccessMode,
  type LarkBotMember,
  type LarkBotMemberRole,
  type LarkGroupTrigger,
  type LarkReplyMode,
  type LarkSessionPolicy,
  type LarkBot,
  type LarkBotInput,
} from "@/lib/lark-types";
import { RegisterBotModal, type AgentOption } from "./RegisterBotModal";

type Draft = Required<Pick<LarkBotInput, "name" | "appId">> & {
  appSecret: string;
  agentId: string | null;
  workspacePath: string;
  enabled: boolean;
  // S134 群聊行为四旋钮（spec: progress/im-entry-layer.md）
  groupTrigger: LarkGroupTrigger;
  triggerPrefix: string;
  sessionPolicy: LarkSessionPolicy;
  replyMode: LarkReplyMode;
  ackMode: LarkAckMode;
  accessMode: LarkAccessMode;
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
  groupTrigger: LARK_POLICY_DEFAULTS.groupTrigger,
  triggerPrefix: "",
  sessionPolicy: LARK_POLICY_DEFAULTS.sessionPolicy,
  replyMode: LARK_POLICY_DEFAULTS.replyMode,
  ackMode: LARK_POLICY_DEFAULTS.ackMode,
  accessMode: LARK_POLICY_DEFAULTS.accessMode,
};

// Radix Select 不允许空串 value：「默认助手」用哨兵值。
const DEFAULT_AGENT = "__default__";

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "稍后重试";
}

const FEISHU_LAUNCHER_URL = "https://open.feishu.cn/page/launcher?from=backend_oneclick";
const LARK_LAUNCHER_URL = "https://open.larkoffice.com/page/launcher?from=backend_oneclick";

export default function LarkBotsSettingsPage() {
  const [bots, setBots] = useState<LarkBot[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredBot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [members, setMembers] = useState<LarkBotMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [preapproveOpenId, setPreapproveOpenId] = useState("");
  const [preapproveRole, setPreapproveRole] = useState<LarkBotMemberRole>("member");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | "one-click" | string | null>(null);
  // 只有列表加载失败才进页面错误态；动作的成败走 toast。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const confirm = useConfirm();

  // 扫码建 / 更新 bot 弹窗状态
  const [registerModalOpen, setRegisterModalOpen] = useState(false);
  const [registerModalMode, setRegisterModalMode] = useState<"create" | "update">("create");
  const [registerModalBot, setRegisterModalBot] = useState<LarkBot | null>(null);

  // 手动创建向导中的 Agent 模式：选择已有 vs 就地新建
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
      if (botRes.status === "rejected") throw botRes.reason;
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause);
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

  const refreshMembers = useCallback(async (botId: string) => {
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/lark-bots/${botId}/members`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.members) {
        setMembers(data.members);
      } else {
        setMembers([]);
      }
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
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

  useEffect(() => {
    if (selectedId) {
      void refreshMembers(selectedId);
    } else {
      setMembers([]);
    }
  }, [selectedId, refreshMembers]);

  // 处理 URL query params（如 ?new=1&agentId=xxx 或 ?id=xxx）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new") === "1";
    const qrParam = params.get("qr") === "1";
    const agentIdParam = params.get("agentId");
    const idParam = params.get("id");

    if (qrParam) {
      setRegisterModalMode("create");
      setRegisterModalBot(null);
      setRegisterModalOpen(true);
    } else if (newParam) {
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
          groupTrigger: bot.groupTrigger ?? LARK_POLICY_DEFAULTS.groupTrigger,
          triggerPrefix: bot.triggerPrefix ?? "",
          sessionPolicy: bot.sessionPolicy ?? LARK_POLICY_DEFAULTS.sessionPolicy,
          replyMode: bot.replyMode ?? LARK_POLICY_DEFAULTS.replyMode,
          ackMode: bot.ackMode ?? LARK_POLICY_DEFAULTS.ackMode,
          accessMode: bot.accessMode ?? LARK_POLICY_DEFAULTS.accessMode,
        });
      }
    }
  }, [selectedId, draft, bots]);

  const selected = bots.find((bot) => bot.id === selectedId) ?? null;

  const openRegisterModal = (mode: "create" | "update", targetBot?: LarkBot | null) => {
    setRegisterModalMode(mode);
    setRegisterModalBot(targetBot ?? null);
    setRegisterModalOpen(true);
  };

  const edit = (bot: LarkBot) => {
    setSelectedId(bot.id);
    setDraft({
      name: bot.name,
      appId: bot.appId,
      appSecret: "",
      agentId: bot.agentId,
      workspacePath: bot.workspacePath ?? "",
      enabled: bot.enabled,
      groupTrigger: bot.groupTrigger ?? LARK_POLICY_DEFAULTS.groupTrigger,
      triggerPrefix: bot.triggerPrefix ?? "",
      sessionPolicy: bot.sessionPolicy ?? LARK_POLICY_DEFAULTS.sessionPolicy,
      replyMode: bot.replyMode ?? LARK_POLICY_DEFAULTS.replyMode,
      ackMode: bot.ackMode ?? LARK_POLICY_DEFAULTS.ackMode,
      accessMode: bot.accessMode ?? LARK_POLICY_DEFAULTS.accessMode,
    });
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
        groupTrigger: data.bot.groupTrigger ?? LARK_POLICY_DEFAULTS.groupTrigger,
        triggerPrefix: data.bot.triggerPrefix ?? "",
        sessionPolicy: data.bot.sessionPolicy ?? LARK_POLICY_DEFAULTS.sessionPolicy,
        replyMode: data.bot.replyMode ?? LARK_POLICY_DEFAULTS.replyMode,
        ackMode: data.bot.ackMode ?? LARK_POLICY_DEFAULTS.ackMode,
        accessMode: data.bot.accessMode ?? LARK_POLICY_DEFAULTS.accessMode,
      });

      const agentName = agents.find((a) => a.id === data.bot.agentId)?.name || "默认助手";
      toast.success(`已接入「${data.testedName || data.bot.name}」`, {
        description: `从本机（${disc.source}）导入并绑定到「${agentName}」，长连接约 15 秒内就绪。`,
      });
      await refresh(true);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  // 手动表单的一键接入
  const handleOneClickSetup = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.appId.trim() || !draft.appSecret.trim()) {
      toast.error("还差必填项", { description: "请填写配置名称、飞书 App ID 和 App Secret" });
      return;
    }

    setBusy("one-click");

    try {
      let targetAgentId = draft.agentId;

      // 1. 如果选择了就地新建 Agent，先创建 Agent
      if (agentMode === "new") {
        if (!newAgentName.trim() || !newAgentSlug.trim()) {
          throw new Error("请填写新 Agent 的名称与标识名");
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
        groupTrigger: draft.groupTrigger,
        triggerPrefix: draft.triggerPrefix.trim() || null,
        sessionPolicy: draft.sessionPolicy,
        replyMode: draft.replyMode,
        ackMode: draft.ackMode,
        accessMode: draft.accessMode,
      };
      const botRes = await request("/api/lark-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botPayload),
      });

      const newBotId = botRes.bot.id;

      // 3. 自动测试凭证连通性
      let testOk = true;
      let testMessage = "";
      try {
        const testRes = await request(`/api/lark-bots/${newBotId}/test`, { method: "POST" });
        testMessage = `凭证可用：已连接飞书应用「${testRes.bot.name}」。`;
      } catch (testErr) {
        testOk = false;
        testMessage = `机器人已保存，但凭证测试没通过（${errText(testErr)}）。检查 App Secret 或应用发布状态。`;
      }

      setSelectedId(newBotId);
      setDraft({
        name: botRes.bot.name,
        appId: botRes.bot.appId,
        appSecret: "",
        agentId: botRes.bot.agentId,
        workspacePath: botRes.bot.workspacePath ?? "",
        enabled: botRes.bot.enabled,
        groupTrigger: botRes.bot.groupTrigger ?? LARK_POLICY_DEFAULTS.groupTrigger,
        triggerPrefix: botRes.bot.triggerPrefix ?? "",
        sessionPolicy: botRes.bot.sessionPolicy ?? LARK_POLICY_DEFAULTS.sessionPolicy,
        replyMode: botRes.bot.replyMode ?? LARK_POLICY_DEFAULTS.replyMode,
        ackMode: botRes.bot.ackMode ?? LARK_POLICY_DEFAULTS.ackMode,
        accessMode: botRes.bot.accessMode ?? LARK_POLICY_DEFAULTS.accessMode,
      });
      if (testOk) {
        toast.success("飞书机器人已接入", { description: `${testMessage}长连接约 15 秒内就绪。` });
      } else {
        toast.warning("机器人已保存，凭证待确认", { description: testMessage });
      }
      await refresh(true);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      const payload = {
        name: draft.name,
        appId: draft.appId,
        appSecret: draft.appSecret,
        agentId: draft.agentId,
        workspacePath: draft.workspacePath || null,
        enabled: draft.enabled,
        groupTrigger: draft.groupTrigger,
        triggerPrefix: draft.triggerPrefix.trim() || null,
        sessionPolicy: draft.sessionPolicy,
        replyMode: draft.replyMode,
        ackMode: draft.ackMode,
        accessMode: draft.accessMode,
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
      setDraft((current) => (current ? { ...current, appSecret: "" } : current));
      toast.success("已保存", { description: "连接配置约 15 秒内由后台对账生效。" });
      await refresh(true);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const handlePreapprove = async () => {
    if (!selectedId || !preapproveOpenId.trim()) return;
    setBusy("preapprove");
    try {
      await request(`/api/lark-bots/${selectedId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openId: preapproveOpenId.trim(),
          role: preapproveRole,
        }),
      });
      setPreapproveOpenId("");
      toast.success("已预先放行", { description: preapproveOpenId.trim() });
      await refreshMembers(selectedId);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const handleMemberDecision = async (memberId: string, status: "approved" | "denied") => {
    if (!selectedId) return;
    setBusy(`decision-${memberId}`);
    try {
      const res = await request(`/api/lark-bots/${selectedId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: memberId, status }),
      });
      toast.success(res.message || (status === "approved" ? "已同意申请" : "已拒绝申请"));
      await refreshMembers(selectedId);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const handleMemberRole = async (memberId: string, role: LarkBotMemberRole) => {
    if (!selectedId) return;
    setBusy(`role-${memberId}`);
    try {
      await request(`/api/lark-bots/${selectedId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: memberId, role }),
      });
      toast.success(role === "admin" ? "已设为管理员" : "已取消管理员");
      await refreshMembers(selectedId);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const handleMemberDelete = async (memberId: string) => {
    if (!selectedId) return;
    const ok = await confirm({
      title: "移除这位成员的权限记录？",
      description: "移除后对方再发消息需要重新申请；审批模式下会重新进入待审批列表。",
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    setBusy(`delete-${memberId}`);
    try {
      await request(`/api/lark-bots/${selectedId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: memberId }),
      });
      toast.success("已移除成员");
      await refreshMembers(selectedId);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!selectedId) return;
    setBusy("test");
    try {
      const data = await request(`/api/lark-bots/${selectedId}/test`, { method: "POST" });
      toast.success("凭证可用", { description: `${data.bot.name}（${data.bot.openId}）` });
      await refresh(true);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: `删除机器人「${selected.name}」？`,
      description: "机器人配置会删除，后台约 15 秒内断开连接；已经生成的 Trellis 会话保留。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await request(`/api/lark-bots/${selected.id}`, { method: "DELETE" });
      setSelectedId(null);
      setDraft(null);
      toast.success("机器人已删除", { description: "后台约 15 秒内断开连接。" });
      await refresh(true);
    } catch (cause) {
      toast.error("操作没有完成", { description: errText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const boundAgent = agents.find((a) => a.id === draft?.agentId) ?? null;
  const connectedCount = bots.filter((b) => b.enabled && b.lastConnectedAt && !b.lastError).length;

  const agentOptions = [
    { value: DEFAULT_AGENT, label: "默认助手", description: "不附加自定义人设" },
    ...agents.map((agent) => ({ value: agent.id, label: `${agent.name} (@${agent.slug})` })),
  ];

  const doRefresh = () => {
    setRefreshing(true);
    void Promise.all([refresh(true), refreshAgents()]).finally(() => setRefreshing(false));
  };

  // ── 新建 / 编辑共用的表单块（原来两份逐字复制，改一处漏一处）──
  const renderCredentials = (d: Draft) => (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="配置名称" hint="在 Trellis 中显示的易记名称">
          <Input
            value={d.name}
            onChange={(e) => setDraft({ ...d, name: e.target.value })}
            placeholder="例如：代码评审专家"
          />
        </Field>
        <Field label="飞书 App ID" hint="开放平台里 cli_ 开头的唯一标识">
          <Input
            className="font-mono"
            value={d.appId}
            onChange={(e) => setDraft({ ...d, appId: e.target.value })}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            autoComplete="off"
          />
        </Field>
      </div>
      <Field
        label="飞书 App Secret"
        hint={
          selected?.hasSecret
            ? "已保存凭证。留空表示不修改；服务端永不回显。"
            : "在开放平台复制，或直接用上方的本机发现一键接入免填。"
        }
      >
        <Input
          className="font-mono"
          type="password"
          value={d.appSecret}
          onChange={(e) => setDraft({ ...d, appSecret: e.target.value })}
          placeholder={selected ? "留空不改" : "请输入 App Secret"}
          autoComplete="new-password"
        />
      </Field>
    </>
  );

  const renderRunOptions = (d: Draft) => (
    <>
      <Field
        label="工作目录（选填）"
        hint="留空使用通用聊天工作区；填写绝对路径后，机器人会以项目模式在该目录执行与读写文件"
      >
        <Input
          className="font-mono"
          value={d.workspacePath}
          onChange={(e) => setDraft({ ...d, workspacePath: e.target.value })}
          placeholder="/absolute/path/to/project"
        />
      </Field>
      <label className="flex items-start gap-2.5 cursor-pointer rounded-card border border-line px-3 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={d.enabled}
          onCheckedChange={(v) => setDraft({ ...d, enabled: v === true })}
        />
        <span className="text-ui text-ink">
          启用长连接监听
          <span className="block text-label text-ink-muted">
            保存或修改凭证后无需重启 Trellis；后台每 15 秒自动对账并保持长连接。
          </span>
        </span>
      </label>
    </>
  );

  const renderGroupBehavior = (d: Draft) => (
    <>
      <div className="text-label text-ink-muted">
        私聊固定：全部消息、引用回复、线性上下文。下面四项只影响群。
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="触发"
          hint="群里什么消息算对机器人说的。它开的话题里的追问、引用它回答的消息，不论哪档都算。"
        >
          <Select
            aria-label="触发"
            value={d.groupTrigger}
            onValueChange={(v) => setDraft({ ...d, groupTrigger: v as LarkGroupTrigger })}
            options={[
              { value: "mention", label: "仅 @ 它时" },
              { value: "prefix", label: "消息以前缀开头" },
              { value: "all", label: "群里所有消息", description: "慎用，每条都跑一次" },
            ]}
          />
          {d.groupTrigger === "prefix" && (
            <Input
              className="mt-2 font-mono"
              aria-label="触发前缀"
              value={d.triggerPrefix}
              onChange={(e) => setDraft({ ...d, triggerPrefix: e.target.value })}
              placeholder="/ask"
            />
          )}
        </Field>
        <Field
          label="上下文"
          hint="按话题：每个话题一棵树，互不串味；整群一条链：旧行为，谁 @ 都接在同一条链尾。"
        >
          <Select
            aria-label="上下文"
            value={d.sessionPolicy}
            onValueChange={(v) => setDraft({ ...d, sessionPolicy: v as LarkSessionPolicy })}
            options={[
              { value: "thread", label: "按话题", description: "每个话题一棵树" },
              { value: "chat", label: "整群一条链" },
            ]}
          />
        </Field>
        <Field
          label="回复形式"
          hint="话题回复把对话收进话题；引用回复平铺在群里带引用；平铺发送不引用原消息。"
        >
          <Select
            aria-label="回复形式"
            value={d.replyMode}
            onValueChange={(v) => setDraft({ ...d, replyMode: v as LarkReplyMode })}
            options={[
              { value: "thread", label: "话题回复" },
              { value: "quote", label: "引用回复" },
              { value: "plain", label: "平铺发送" },
            ]}
          />
        </Field>
        <Field label="收到确认" hint="收到消息先回一个 OnIt 表情再开始跑。">
          <Select
            aria-label="收到确认"
            value={d.ackMode}
            onValueChange={(v) => setDraft({ ...d, ackMode: v as LarkAckMode })}
            options={[
              { value: "reaction", label: "表情确认" },
              { value: "none", label: "不确认" },
            ]}
          />
        </Field>
      </div>
      {d.sessionPolicy === "thread" && d.replyMode !== "thread" && (
        <div className="text-label text-ink-muted">
          上下文按话题、回复却不进话题：飞书不会给后续消息话题 ID，追问只能靠引用回复归树。建议回复形式也选「话题回复」。
        </div>
      )}
    </>
  );

  const renderAccessMode = (d: Draft) => (
    <Field
      label="权限模式"
      hint="审批模式下，不在白名单的用户必须经管理员审批放行后才能与机器人对话。"
    >
      <Select
        aria-label="权限模式"
        value={d.accessMode}
        onValueChange={(v) => setDraft({ ...d, accessMode: v as LarkAccessMode })}
        options={[
          { value: "open", label: "开放", description: "默认：群内 @ 或私聊直接对话" },
          { value: "approval", label: "需管理员审批", description: "发送人白名单 + 挂起消息审批后重放" },
        ]}
      />
    </Field>
  );

  const card = "rounded-card border border-line bg-surface p-4 flex flex-col gap-3";
  const cardTitle = "text-ui font-semibold text-ink-strong";

  return (
    <div className="flex flex-col gap-5">
      {/* 扫码创建 / 补权限弹窗 */}
      <RegisterBotModal
        open={registerModalOpen}
        mode={registerModalMode}
        bot={registerModalBot}
        agents={agents}
        onClose={() => setRegisterModalOpen(false)}
        onSuccess={() => void refresh(true)}
        refreshAgents={refreshAgents}
      />

      <PageHeader
        title="飞书机器人"
        count={loading && !bots.length ? undefined : bots.length}
        countUnit="个机器人"
        subtitle={loading && !bots.length ? undefined : `${connectedCount} 个已连接`}
        actions={
          <>
            <IconButton label="刷新" onClick={doRefresh} disabled={refreshing}>
              <Icon icon={RefreshCw} className={refreshing ? "animate-spin" : undefined} />
            </IconButton>
            <Button onClick={() => create()} className="max-md:hidden">
              <Icon icon={Settings2} />
              手动接入
            </Button>
            <Button variant="primary" onClick={() => openRegisterModal("create")}>
              <Icon icon={QrCode} />
              扫码创建机器人
            </Button>
          </>
        }
      />

      {loadError !== null && !bots.length && !loading ? (
        <ErrorCallout error={loadError} title="机器人列表加载失败" onRetry={() => void refresh()} />
      ) : (
    <div className="flex flex-col md:flex-row gap-6">
      {/* 左侧：机器人列表 */}
      <aside className="md:w-[280px] shrink-0 flex flex-col gap-2">
        {loading && !bots.length ? (
          <div role="status" aria-label="加载中" className="rounded-card border border-line bg-surface divide-y divide-line-faint">
            {[0, 1].map((i) => (
              <div key={i} className="px-3.5 py-3 flex flex-col gap-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : bots.length === 0 ? (
          <EmptyState
            compact
            icon={MessagesSquare}
            title="还没有接入机器人"
            description="扫码几秒就能建好一个飞书机器人，或手动接入已有应用。"
            action={
              <Button size="sm" variant="primary" onClick={() => openRegisterModal("create")}>
                <Icon icon={QrCode} size="sm" />
                扫码创建
              </Button>
            }
            className="rounded-card border border-line"
          />
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line-faint">
            {bots.map((bot) => {
              const botAgent = agents.find((a) => a.id === bot.agentId);
              const isSelected = selectedId === bot.id;
              const hasMissingScopes = Boolean(bot.missingScopes && bot.missingScopes.length > 0);

              return (
                <div
                  key={bot.id}
                  className={cn(
                    "relative flex flex-col gap-1.5 px-3.5 py-3 transition-colors duration-100",
                    isSelected ? "bg-accent-muted" : "hover:bg-surface-hover",
                    !bot.enabled && "opacity-60",
                  )}
                >
                  {isSelected && (
                    <span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-accent" />
                  )}
                  <button
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => edit(bot)}
                    className="text-left w-full flex flex-col gap-0.5 max-md:min-h-11"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-ui font-medium text-ink-strong flex-1">
                        {bot.botName || bot.name}
                      </span>
                      <StatusBadge bot={bot} />
                    </span>
                    <span className="text-label font-mono text-ink-faint truncate">{bot.appId}</span>
                    <span className="flex items-center gap-1 text-label truncate text-ink-muted">
                      <Icon icon={Bot} size="sm" className="text-ink-faint" />
                      {botAgent ? botAgent.name : "默认助手"}
                    </span>
                  </button>

                  {/* 缺权限提示 */}
                  {hasMissingScopes && (
                    <div className="px-2 py-1.5 rounded-field bg-warn-muted border border-warn-line text-warn-ink text-label leading-snug">
                      <div className="font-medium flex items-center gap-1">
                        <Icon icon={TriangleAlert} size="sm" />
                        缺少权限
                      </div>
                      <div className="font-mono text-nano break-all mt-0.5" title={bot.missingScopes!.join(", ")}>
                        {bot.missingScopes!.join(", ")}
                      </div>
                    </div>
                  )}

                  <Button
                    type="button"
                    variant={hasMissingScopes ? "secondary" : "ghost"}
                    size="sm"
                    className="self-start -ml-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRegisterModal("update", bot);
                    }}
                  >
                    <Icon icon={QrCode} size="sm" />
                    {hasMissingScopes ? "扫码补权限" : "扫码更新配置"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </aside>

      {/* 右侧：发现区 + 向导式创建 / 编辑面板 */}
      <main className="flex-1 min-w-0 flex flex-col gap-4">
        {/* 本机已发现应用推荐区（无需复制 App ID / Secret） */}
        {discovered.length > 0 && (
          <section className="rounded-card border border-accent-line bg-accent-muted p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-ui text-ink">
                <Icon icon={Sparkles} className="text-accent-ink" />
                检测到本机已配置的飞书应用（一键直连，无需复制 App ID / Secret）
              </div>
              <span className="text-label text-ink-muted">来源：~/.feishu-cli / 环境变量</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {discovered.map((disc) => {
                const isImporting = busy === `import-${disc.appId}`;
                return (
                  <div
                    key={disc.appId}
                    className="flex flex-col justify-between p-3 rounded-card border border-line bg-surface gap-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Icon icon={Bot} size="sm" className="text-ink-muted" />
                        <span className="font-medium text-ui truncate text-ink">{disc.name}</span>
                        {disc.online ? (
                          <Badge variant="positive" className="shrink-0">在线可用</Badge>
                        ) : (
                          <Badge variant="danger" className="shrink-0">离线</Badge>
                        )}
                      </div>
                      <div className="text-label font-mono text-ink-faint truncate mt-0.5">{disc.appId}</div>
                      <div className="text-label text-ink-faint truncate mt-0.5">
                        来源 {disc.source}
                        {disc.alreadyRegistered && disc.boundAgentName && (
                          <span className="text-accent-ink ml-1">· 绑定于 @{disc.boundAgentSlug}</span>
                        )}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-line-faint">
                      {disc.alreadyRegistered && disc.registeredBotId ? (
                        <Button
                          type="button"
                          size="sm"
                          className="w-full"
                          onClick={() => {
                            const found = bots.find((b) => b.id === disc.registeredBotId);
                            if (found) edit(found);
                          }}
                        >
                          已接入，查看 / 编辑
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          className="w-full"
                          loading={isImporting}
                          onClick={() => void handleImportDiscovered(disc)}
                        >
                          <Icon icon={Zap} size="sm" />
                          一键接入并连接
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 当没有选中任何 bot 且没有主动打开草稿时 */}
        {!draft ? (
          <EmptyState
            icon={MessagesSquare}
            title="快速接入飞书机器人"
            description="点「扫码创建机器人」直接生成二维码配对；或在左侧选择已有机器人调整参数与权限。"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant="primary" onClick={() => openRegisterModal("create")}>
                  <Icon icon={QrCode} />
                  扫码创建机器人
                </Button>
                <Button type="button" onClick={() => create()}>
                  <Icon icon={Settings2} />
                  手动接入已有应用
                </Button>
              </div>
            }
            className="rounded-card border border-line"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* 选中机器人且有 missingScopes 时在编辑区顶部提示 */}
            {selected && selected.missingScopes && selected.missingScopes.length > 0 && (
              <div className="p-4 rounded-card border border-warn-line bg-warn-muted text-warn-ink flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-ui flex items-center gap-1.5">
                    <Icon icon={TriangleAlert} size="sm" />
                    飞书提示这个机器人缺少权限
                  </div>
                  <div className="font-mono text-label break-all mt-0.5" title={selected.missingScopes.join(", ")}>
                    {selected.missingScopes.join(", ")}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  onClick={() => openRegisterModal("update", selected)}
                >
                  <Icon icon={QrCode} size="sm" />
                  扫码一键补权限
                </Button>
              </div>
            )}

            {/* 新建模式下：折叠式「手动接入已有应用」外壳 */}
            {!selected ? (
              <details open className="group rounded-card border border-line bg-surface overflow-hidden">
                <summary className="px-4 py-3 cursor-pointer select-none font-semibold text-ui text-ink flex items-center justify-between hover:bg-surface-hover transition-colors duration-100 max-md:min-h-11">
                  <span className="flex items-center gap-2">
                    <Icon icon={Settings2} className="text-ink-muted" />
                    手动接入已有应用
                    <span className="text-label text-ink-faint font-normal">（填 App ID / Secret）</span>
                  </span>
                  <Icon icon={ChevronDown} size="sm" className="text-ink-faint transition-transform duration-100 group-open:rotate-180" />
                </summary>

                <div className="p-4 pt-3 border-t border-line flex flex-col gap-5">
                  {/* 指南卡片与一键创建链接 */}
                  <div className="rounded-card border border-line bg-surface-muted p-4">
                    <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
                      <div>
                        <div className="text-ui font-semibold text-ink">飞书 / Lark 应用一键创建与接入</div>
                        <ol className="text-label text-ink-muted mt-1 leading-relaxed list-decimal pl-4 flex flex-col gap-0.5">
                          <li>点右侧「飞书一键创建」，用预置模板快速生成自建应用；</li>
                          <li>
                            模板已配好机器人与长连接事件，创建后把 <b>App ID</b> 和 <b>App Secret</b> 填到下面；
                          </li>
                          <li>
                            若本机已安装并登录{" "}
                            <code className="px-1 py-0.5 bg-surface rounded font-mono text-nano">feishu-cli</code>
                            ，上方会<b>自动识别</b>，直接一键接入即可。
                          </li>
                        </ol>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <Button asChild variant="primary" size="sm">
                          <a
                            href={FEISHU_LAUNCHER_URL}
                            target="_blank"
                            rel="noreferrer"
                            title="在飞书开放平台用官方模板一键创建机器人应用"
                          >
                            <Icon icon={Zap} size="sm" />
                            飞书一键创建
                            <Icon icon={ArrowUpRight} size="sm" />
                          </a>
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                          <a
                            href={LARK_LAUNCHER_URL}
                            target="_blank"
                            rel="noreferrer"
                            title="在 Lark 国际版用官方模板一键创建机器人应用"
                          >
                            Lark 国际版
                            <Icon icon={ArrowUpRight} size="sm" />
                          </a>
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* 1. 基础与凭证信息 */}
                  <section className="flex flex-col gap-3">
                    <div className={cardTitle}>1. 应用与凭证信息</div>
                    {renderCredentials(draft)}
                  </section>

                  {/* 2. 绑定 Agent */}
                  <section className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className={cardTitle}>2. 绑定执行 Agent（人设、技能与工具）</div>
                        <div className="text-label text-ink-muted mt-0.5">
                          飞书用户发消息时，会以该 Agent 的专属提示词、挂载技能与模型运行。
                        </div>
                      </div>
                      <SegmentedControl
                        aria-label="Agent 来源"
                        size="sm"
                        value={agentMode}
                        onValueChange={setAgentMode}
                        options={[
                          { value: "existing", label: "选择已有 Agent" },
                          { value: "new", label: "就地新建 Agent" },
                        ]}
                      />
                    </div>

                    {agentMode === "existing" ? (
                      <Select
                        aria-label="绑定的 Agent"
                        value={draft.agentId ?? DEFAULT_AGENT}
                        onValueChange={(v) =>
                          setDraft({ ...draft, agentId: v === DEFAULT_AGENT ? null : v })
                        }
                        options={agentOptions}
                      />
                    ) : (
                      <div className="p-3 rounded-card border border-line flex flex-col gap-3">
                        <div className="text-label text-ink-muted">
                          在这里定义新人设，创建后自动与这个机器人绑定。
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <Field label="Agent 名字" hint="例如：技术支持">
                            <Input
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
                          <Field label="标识名" hint="英文 / 数字 / 连字符，≤32 字符">
                            <Input
                              className="font-mono"
                              value={newAgentSlug}
                              onChange={(e) => setNewAgentSlug(e.target.value)}
                              placeholder="code-reviewer"
                            />
                          </Field>
                        </div>
                        <Field label="一句话职责自述">
                          <Input
                            value={newAgentDesc}
                            onChange={(e) => setNewAgentDesc(e.target.value)}
                            placeholder="例如：专注代码架构与潜在缺陷审查"
                          />
                        </Field>
                        <Field label="系统提示词">
                          <Textarea
                            className="resize-y"
                            rows={3}
                            value={newAgentPrompt}
                            onChange={(e) => setNewAgentPrompt(e.target.value)}
                            placeholder="你是飞书助手，主要职责是..."
                          />
                        </Field>
                        <Field label="指定模型" hint="留空跟随会话默认模型">
                          <Input
                            className="font-mono"
                            value={newAgentModel}
                            onChange={(e) => setNewAgentModel(e.target.value)}
                            placeholder="haiku / sonnet / opus / codex（留空默认）"
                          />
                        </Field>
                      </div>
                    )}
                  </section>

                  {/* 3. 运行选项与工作目录 */}
                  <section className="flex flex-col gap-3">
                    <div className={cardTitle}>3. 运行目录与连接控制</div>
                    {renderRunOptions(draft)}
                  </section>

                  {/* 4. 群聊行为 */}
                  <section className="flex flex-col gap-3">
                    <div className={cardTitle}>4. 群聊行为</div>
                    {renderGroupBehavior(draft)}
                  </section>

                  {/* 5. 对话权限 */}
                  <section className="flex flex-col gap-3">
                    <div className={cardTitle}>5. 对话权限控制</div>
                    {renderAccessMode(draft)}
                  </section>

                  {/* 提交动作栏 */}
                  <div className="pt-3 border-t border-line flex items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => void handleOneClickSetup()}
                      loading={busy === "one-click"}
                      disabled={
                        busy !== null ||
                        !draft.name.trim() ||
                        !draft.appId.trim() ||
                        !draft.appSecret.trim()
                      }
                    >
                      测试凭证并接入绑定
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={busy !== null}>
                      取消
                    </Button>
                  </div>
                </div>
              </details>
            ) : (
              /* 编辑已有机器人时的平铺面板 */
              <>
                {/* 1. 基础与凭证信息 */}
                <section className={card}>
                  <div className={cardTitle}>1. 应用与凭证信息</div>
                  {renderCredentials(draft)}
                </section>

                {/* 2. 绑定 Agent 策略（Agent-first 体验） */}
                <section className={card}>
                  <div>
                    <div className={cardTitle}>2. 绑定执行 Agent（人设、技能与工具）</div>
                    <div className="text-label text-ink-muted mt-0.5">
                      飞书用户发消息时，会以该 Agent 的专属提示词、挂载技能与模型运行。
                    </div>
                  </div>
                  <Select
                    aria-label="绑定的 Agent"
                    value={draft.agentId ?? DEFAULT_AGENT}
                    onValueChange={(v) => setDraft({ ...draft, agentId: v === DEFAULT_AGENT ? null : v })}
                    options={agentOptions}
                  />
                  {boundAgent && (
                    <div className="flex items-center gap-1.5 text-label">
                      <span className="text-ink-muted">当前绑定人设</span>
                      <span className="text-ink font-medium">{boundAgent.name}</span>
                      <Button asChild variant="link" size="sm" className="ml-1">
                        <Link href={`/settings/agents?id=${encodeURIComponent(boundAgent.id)}`}>
                          查看 / 编辑人设
                          <Icon icon={ArrowUpRight} size="sm" />
                        </Link>
                      </Button>
                    </div>
                  )}
                </section>

                {/* 3. 运行选项与工作目录 */}
                <section className={card}>
                  <div className={cardTitle}>3. 运行目录与连接控制</div>
                  {renderRunOptions(draft)}
                </section>

                {/* 4. 群聊行为 */}
                <section className={card}>
                  <div className={cardTitle}>4. 群聊行为</div>
                  {renderGroupBehavior(draft)}
                </section>

                {/* 5. 对话权限 */}
                <section className={card}>
                  <div className={cardTitle}>5. 对话权限控制</div>
                  {renderAccessMode(draft)}

                  {draft.accessMode === "approval" && (
                    <div className="flex flex-col gap-4 pt-2">
                      {members.filter((m) => m.role === "admin" && m.status === "approved").length === 0 && (
                        <div className="p-3 rounded-card border border-accent-line bg-accent-muted text-ui leading-relaxed">
                          <div className="font-semibold text-accent-ink flex items-center gap-1.5 mb-1">
                            <Icon icon={Lightbulb} size="sm" />
                            先配置第一个管理员
                          </div>
                          <div className="text-label text-ink-muted">
                            这个机器人还没有管理员。管理员本人在飞书私聊给机器人发任意一句话（如「申请」），进入下方待审批列表后点
                            <b>「设为管理员」</b>即可完成初始化。
                          </div>
                        </div>
                      )}

                      {/* 预先放行表单 */}
                      <div className="p-3 rounded-card border border-line flex flex-col gap-2">
                        <div className="text-label font-medium text-ink">按 open_id 手动预先放行</div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            className="font-mono"
                            wrapperClassName="flex-1"
                            aria-label="用户 open_id"
                            value={preapproveOpenId}
                            onChange={(e) => setPreapproveOpenId(e.target.value)}
                            placeholder="用户的 open_id（例如 ou_xxxxxxxxxxxxxxxx）"
                          />
                          <Select
                            aria-label="角色"
                            className="sm:w-32"
                            value={preapproveRole}
                            onValueChange={(v) => setPreapproveRole(v as LarkBotMemberRole)}
                            options={[
                              { value: "member", label: "普通成员" },
                              { value: "admin", label: "管理员" },
                            ]}
                          />
                          <Button
                            type="button"
                            onClick={() => void handlePreapprove()}
                            loading={busy === "preapprove"}
                            disabled={busy !== null || !preapproveOpenId.trim()}
                          >
                            预先放行
                          </Button>
                        </div>
                      </div>

                      {/* 成员列表与审批 */}
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <div className="text-label font-medium text-ink">
                            成员与申请 <span className="tabular-nums text-ink-faint">{members.length}</span>
                          </div>
                          {membersLoading && <Spinner size="sm" label="刷新中" />}
                        </div>

                        {members.length === 0 ? (
                          <EmptyState
                            compact
                            icon={Users}
                            title="还没有成员或申请"
                            description="有人私聊机器人后，申请会出现在这里等你审批。"
                            className="rounded-card border border-dashed border-line"
                          />
                        ) : (
                          <div className="divide-y divide-line-faint border border-line rounded-card overflow-hidden">
                            {members.map((m) => {
                              const isPending = m.status === "pending";
                              const isApproved = m.status === "approved";
                              const isDenied = m.status === "denied";
                              const isAdmin = m.role === "admin";
                              const displayName = m.name || `用户 (${m.openId.slice(-6)})`;

                              return (
                                <div
                                  key={m.id}
                                  className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-ui"
                                >
                                  <div className="min-w-0 flex flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="font-medium text-ink">{displayName}</span>
                                      <Badge className="font-mono">{m.openId}</Badge>
                                      <Badge className="font-mono">短码 {m.code}</Badge>
                                      <Badge variant={isAdmin ? "accent" : "neutral"}>
                                        {isAdmin ? "管理员" : "成员"}
                                      </Badge>
                                      <Badge variant={isPending ? "warn" : isApproved ? "positive" : "danger"}>
                                        {isPending ? "待审批" : isApproved ? "已通过" : "已拒绝"}
                                      </Badge>
                                    </div>

                                    {m.pendingPreview && (
                                      <div className="text-label text-ink-muted line-clamp-2">
                                        <span className="text-ink-faint">申请内容：</span>
                                        {m.pendingPreview}
                                      </div>
                                    )}

                                    <div className="text-label text-ink-faint">
                                      申请于 {new Date(m.appliedAt).toLocaleString()}
                                      {m.decidedAt &&
                                        ` · 审批于 ${new Date(m.decidedAt).toLocaleString()}（${m.decidedBy || "管理员"}）`}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-1 shrink-0">
                                    {isPending && (
                                      <>
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          disabled={busy !== null}
                                          onClick={() => void handleMemberDecision(m.id, "approved")}
                                        >
                                          同意
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          disabled={busy !== null}
                                          onClick={() => void handleMemberDecision(m.id, "denied")}
                                        >
                                          拒绝
                                        </Button>
                                      </>
                                    )}

                                    {isApproved && (
                                      <>
                                        {isAdmin ? (
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy !== null}
                                            onClick={() => void handleMemberRole(m.id, "member")}
                                          >
                                            取消管理员
                                          </Button>
                                        ) : (
                                          <Button
                                            type="button"
                                            size="sm"
                                            disabled={busy !== null}
                                            onClick={() => void handleMemberRole(m.id, "admin")}
                                          >
                                            设为管理员
                                          </Button>
                                        )}
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          disabled={busy !== null}
                                          onClick={() => void handleMemberDecision(m.id, "denied")}
                                        >
                                          拒绝
                                        </Button>
                                      </>
                                    )}

                                    {isDenied && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={busy !== null}
                                        onClick={() => void handleMemberDecision(m.id, "approved")}
                                      >
                                        重新放行
                                      </Button>
                                    )}

                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy !== null}
                                      onClick={() => void handleMemberDelete(m.id)}
                                    >
                                      移除
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </section>

                {/* 连接状态与会话明细（编辑模式） */}
                <section className="rounded-card border border-line bg-surface overflow-hidden">
                  <div className="px-4 py-3 border-b border-line flex items-center gap-2">
                    <div className={cardTitle}>连接状态</div>
                    <StatusBadge bot={selected} />
                    <span className="ml-auto text-label text-ink-muted">
                      {selected.lastConnectedAt
                        ? `最近连接 ${new Date(selected.lastConnectedAt).toLocaleString()}`
                        : "尚未连接"}
                    </span>
                  </div>
                  {selected.lastError && (
                    <div className="px-4 py-2.5 border-b border-line">
                      <ErrorCallout compact error={selected.lastError} title="长连接报错" hint="检查 App Secret、应用发布状态或权限后点「测试凭证」。" />
                    </div>
                  )}
                  <div className="px-4 py-3">
                    <div className="text-ui font-medium text-ink mb-2">飞书会话（最近）</div>
                    {selected.chats.length === 0 ? (
                      <div className="text-label text-ink-muted">
                        还没有收到消息。在飞书里给机器人发一条私聊开始对话。
                      </div>
                    ) : (
                      <div className="rounded-card border border-line divide-y divide-line-faint overflow-hidden">
                        {selected.chats.map((chat) => (
                          <a
                            key={chat.id}
                            href={
                              chat.sessionId
                                ? `/?session=${encodeURIComponent(chat.sessionId)}&node=${encodeURIComponent(chat.lastNodeId || "")}`
                                : undefined
                            }
                            aria-disabled={!chat.sessionId}
                            className="flex items-center gap-3 px-3 py-2 hover:bg-surface-hover transition-colors duration-100 aria-disabled:opacity-50 max-md:min-h-11"
                          >
                            <Icon
                              icon={chat.chatType === "group" ? Users : User}
                              className="text-ink-faint"
                              aria-label={chat.chatType === "group" ? "群聊" : "私聊"}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-ui text-ink truncate">{chat.title || chat.chatId}</span>
                              <span className="block text-label text-ink-faint font-mono truncate">{chat.chatId}</span>
                            </span>
                            <span className="text-label text-ink-faint shrink-0">
                              {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleString() : ""}
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                {/* 提交动作栏 */}
                <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-line">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void save()}
                    loading={busy === "save"}
                    disabled={busy !== null || !draft.name.trim() || !draft.appId.trim()}
                  >
                    保存变更
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void test()}
                    loading={busy === "test"}
                    disabled={busy !== null}
                  >
                    测试凭证
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => openRegisterModal("update", selected)}
                    disabled={busy !== null}
                  >
                    <Icon icon={QrCode} />
                    扫码更新配置 / 补权限
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="ml-auto"
                    onClick={() => void remove()}
                    loading={busy === "delete"}
                    disabled={busy !== null}
                  >
                    删除
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
      )}
    </div>
  );
}

function StatusBadge({ bot }: { bot: LarkBot }) {
  const text = !bot.enabled ? "已停用" : bot.lastError ? "异常" : bot.lastConnectedAt ? "已连接" : "待连接";
  const variant = bot.lastError
    ? "danger"
    : bot.lastConnectedAt && bot.enabled
      ? "positive"
      : "neutral";
  return (
    <Badge variant={variant} className="shrink-0">
      {text}
    </Badge>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-ui font-medium text-ink">{label}</div>
      {hint && <div className="text-label text-ink-muted">{hint}</div>}
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
