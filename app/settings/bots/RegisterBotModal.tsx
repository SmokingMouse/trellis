"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  Hourglass,
  Lightbulb,
  QrCode,
  RefreshCw,
  ArrowUpRight,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
  Button,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Spinner,
  StatusDot,
  Textarea,
} from "@/components/ui";
import {
  type LarkAccessMode,
  type LarkBot,
  type LarkRegisterRequest,
  type LarkRegisterSession,
  type LarkRegisterStart,
  type LarkRegisterStatus,
} from "@/lib/lark-types";

export type AgentOption = { id: string; name: string; slug: string };

// Radix Select 不允许空串 value：「默认助手」用哨兵值。
const DEFAULT_AGENT = "__default__";

export type RegisterBotModalProps = {
  open: boolean;
  mode: "create" | "update";
  bot?: LarkBot | null;
  agents: AgentOption[];
  onClose: () => void;
  onSuccess: () => void;
  refreshAgents?: () => Promise<void>;
};

export function RegisterBotModal({
  open,
  mode,
  bot,
  agents,
  onClose,
  onSuccess,
  refreshAgents,
}: RegisterBotModalProps) {
  // Step: 1 = 填写信息 (create 专属), 2 = 扫码确认 (create/update), 3 = 完成 (done)
  const [step, setStep] = useState<1 | 2 | 3>(mode === "update" ? 2 : 1);

  // Step 1 Form fields
  const [name, setName] = useState("Trellis 助手");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [accessMode, setAccessMode] = useState<LarkAccessMode>("approval");

  // 就地新建 Agent
  const [agentMode, setAgentMode] = useState<"existing" | "new">("existing");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentSlug, setNewAgentSlug] = useState("");
  const [newAgentDesc, setNewAgentDesc] = useState("");
  const [newAgentPrompt, setNewAgentPrompt] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("");

  // Step 2 Session state
  const [session, setSession] = useState<LarkRegisterSession | null>(null);
  const [qrSvg, setQrSvg] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  // 保持 currentSessionIdRef 同步以便在卸载/关闭时清理
  useEffect(() => {
    currentSessionIdRef.current = session?.sessionId ?? null;
  }, [session?.sessionId]);

  // 取消后端注册会话
  const cancelSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/lark-bots/register/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        keepalive: true,
      });
    } catch {
      // 忽略取消失败
    }
  }, []);

  const handleClose = useCallback(() => {
    if (currentSessionIdRef.current && session?.status === "waiting") {
      void cancelSession(currentSessionIdRef.current);
    }
    onClose();
  }, [cancelSession, onClose, session?.status]);

  // 启动注册会话
  const startRegister = useCallback(
    async (targetMode: "create" | "update") => {
      setStarting(true);
      setError(null);

      // 如果已有未完成会话，先取消
      if (currentSessionIdRef.current) {
        void cancelSession(currentSessionIdRef.current);
      }

      try {
        let finalAgentId = agentId;

        // 如果是就地新建 Agent
        if (targetMode === "create" && agentMode === "new") {
          if (!newAgentName.trim() || !newAgentSlug.trim()) {
            throw new Error("请填写新 Agent 的名字与标识名");
          }
          const agentRes = await fetch("/api/agents", {
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
          const agentData = await agentRes.json();
          if (!agentRes.ok) {
            throw new Error(agentData.error || "创建 Agent 失败");
          }
          finalAgentId = agentData.agent.id;
          if (refreshAgents) void refreshAgents();
        }

        let bodyPayload: LarkRegisterRequest;
        if (targetMode === "create") {
          bodyPayload = {
            mode: "create",
            name: name.trim() || "Trellis 助手",
            description: description.trim() || undefined,
            agentId: finalAgentId || null,
            workspacePath: workspacePath.trim() || null,
            accessMode,
          };
        } else {
          if (!bot?.id) throw new Error("缺少待更新的机器人 ID");
          bodyPayload = {
            mode: "update",
            botId: bot.id,
            scopes: bot.missingScopes,
          };
        }

        const res = await fetch("/api/lark-bots/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload),
        });

        const data: LarkRegisterStart & { error?: string } = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "发起扫码注册失败");
        }

        // 生成二维码 SVG
        const svgString = await QRCode.toString(data.url, {
          type: "svg",
          margin: 1,
          // ui-guard-allow(hex): 二维码必须纯黑白才好扫，不随皮肤
          color: { dark: "#000000", light: "#ffffff" },
        });

        setQrSvg(svgString);
        setSession({
          sessionId: data.sessionId,
          mode: targetMode,
          status: "waiting",
          url: data.url,
          expiresAt: data.expiresAt,
          botId: targetMode === "update" ? bot?.id ?? null : null,
          appId: targetMode === "update" ? bot?.appId ?? null : null,
          connected: false,
          adminBound: false,
          welcomeSent: false,
          error: null,
        });

        setTimeLeft(Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000)));
        setStep(2);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setStarting(false);
      }
    },
    [
      accessMode,
      agentId,
      agentMode,
      bot,
      cancelSession,
      description,
      name,
      newAgentDesc,
      newAgentModel,
      newAgentName,
      newAgentPrompt,
      newAgentSlug,
      refreshAgents,
      workspacePath,
    ],
  );

  // 弹窗打开时的初始状态重置与 update 模式自启动
  useEffect(() => {
    if (!open) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      setSession(null);
      setQrSvg("");
      setError(null);
      return;
    }

    if (mode === "update") {
      setStep(2);
      void startRegister("update");
    } else {
      setStep(1);
      setName("Trellis 助手");
      setDescription("");
      setAgentId(null);
      setWorkspacePath("");
      setAccessMode("approval");
      setAgentMode("existing");
      setNewAgentName("");
      setNewAgentSlug("");
      setNewAgentDesc("");
      setNewAgentPrompt("");
      setNewAgentModel("");
      setSession(null);
      setQrSvg("");
      setError(null);
    }
  }, [open, mode, startRegister]);

  // Step 2 倒计时与轮询
  useEffect(() => {
    if (!open || step !== 2 || !session?.sessionId) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      return;
    }

    const sessionId = session.sessionId;

    // 1. 倒计时定时器（每秒刷新）
    countdownTimerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        const remaining = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
        return remaining;
      });
    }, 1000);

    // 2. 轮询状态（每 2s 轮询一次）
    const isTerminal = (status: LarkRegisterStatus) =>
      status === "done" || status === "denied" || status === "expired" || status === "cancelled" || status === "error";

    if (!isTerminal(session.status)) {
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/lark-bots/register/${encodeURIComponent(sessionId)}`, {
            cache: "no-store",
          });
          if (res.status === 404) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
            setSession((prev) =>
              prev ? { ...prev, status: "error", error: "会话已失效（服务可能重启过），请重新生成二维码" } : prev,
            );
            return;
          }
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || "轮询状态失败");
          }
          const data: LarkRegisterSession = await res.json();
          setSession(data);

          if (data.status === "done") {
            setStep(3);
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
            onSuccess();
          } else if (isTerminal(data.status)) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          }
        } catch (pollErr) {
          // 仅记录网络瞬时错误，不中断轮询
          console.warn("[register-bot] 轮询异常:", pollErr);
        }
      }, 2000);
    }

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, [open, step, session?.sessionId, session?.expiresAt, session?.status, onSuccess]);

  if (!open) return null;

  const isExpired = session?.status === "expired" || (timeLeft <= 0 && session?.status === "waiting");
  const isDenied = session?.status === "denied";
  const isError = session?.status === "error" || Boolean(session?.error);

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const currentBotName = mode === "update" ? (bot?.botName || bot?.name || "机器人") : (name.trim() || "Trellis 助手");

  return (
    <Modal onClose={handleClose} size={step === 1 ? "lg" : "md"} panelClassName="max-h-[90vh] flex flex-col">
      {/* 弹窗顶部 Header */}
      <div className="px-5 py-4 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon
            icon={step === 3 ? CircleCheck : mode === "update" ? RefreshCw : QrCode}
            className={step === 3 ? "text-positive" : "text-ink-muted"}
          />
          <span className="font-semibold text-ui text-ink-strong truncate">
            {mode === "update"
              ? step === 3
                ? "配置已更新"
                : "补权限 / 更新配置"
              : step === 1
                ? "扫码创建飞书机器人 · 第 1/3 步：填写信息"
                : step === 2
                  ? "扫码创建飞书机器人 · 第 2/3 步：扫码确认"
                  : `「${currentBotName}」已创建并连接`}
          </span>
        </div>
        <IconButton label="关闭" size="sm" onClick={handleClose}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>

      {/* 弹窗内容主体 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
        {error && <ErrorCallout compact error={error} title="没能发起扫码" />}

        {/* ── 第 1 步：填信息（Create 模式专属） ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="text-label text-ink-muted leading-relaxed">
              填好配置后将直接生成飞书官方确认二维码，手机扫码或浏览器一键确认即可自动接入，无需手动创建应用及配置 Secret。
            </div>

            <div className="space-y-3.5">
              <Field label="机器人名称" hint="显示在飞书和 Trellis 中的名称">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Trellis 助手"
                />
              </Field>

              <Field label="描述（选填）" hint="机器人功能职责说明">
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：团队智能研发助手"
                />
              </Field>

              {/* 绑定 Agent */}
              <div className="rounded-card border border-line p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-ui font-medium text-ink">绑定执行 Agent</div>
                    <div className="text-label text-ink-muted">消息会以这个 Agent 的专属提示词、技能与模型运行</div>
                  </div>
                  <SegmentedControl
                    aria-label="Agent 来源"
                    size="sm"
                    value={agentMode}
                    onValueChange={setAgentMode}
                    options={[
                      { value: "existing", label: "选择已有" },
                      { value: "new", label: "就地新建" },
                    ]}
                  />
                </div>

                {agentMode === "existing" ? (
                  <Select
                    aria-label="绑定的 Agent"
                    value={agentId ?? DEFAULT_AGENT}
                    onValueChange={(v) => setAgentId(v === DEFAULT_AGENT ? null : v)}
                    options={[
                      { value: DEFAULT_AGENT, label: "默认助手", description: "不附加自定义人设" },
                      ...agents.map((a) => ({ value: a.id, label: `${a.name} (@${a.slug})` })),
                    ]}
                  />
                ) : (
                  <div className="space-y-2.5 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <Field label="Agent 名字" hint="例如：代码审查专家">
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
                          placeholder="代码审查专家"
                        />
                      </Field>
                      <Field label="标识名" hint="英文 / 数字 / 连字符">
                        <Input
                          className="font-mono"
                          value={newAgentSlug}
                          onChange={(e) => setNewAgentSlug(e.target.value)}
                          placeholder="code-reviewer"
                        />
                      </Field>
                    </div>
                    <Field label="一句话职责">
                      <Input
                        value={newAgentDesc}
                        onChange={(e) => setNewAgentDesc(e.target.value)}
                        placeholder="专注代码架构与潜在缺陷审查"
                      />
                    </Field>
                    <Field label="系统提示词">
                      <Textarea
                        className="resize-y"
                        rows={2}
                        value={newAgentPrompt}
                        onChange={(e) => setNewAgentPrompt(e.target.value)}
                        placeholder="你是代码审查专家，主要职责是..."
                      />
                    </Field>
                    <Field label="指定模型（选填）">
                      <Input
                        className="font-mono"
                        value={newAgentModel}
                        onChange={(e) => setNewAgentModel(e.target.value)}
                        placeholder="留空默认"
                      />
                    </Field>
                  </div>
                )}
              </div>

              <Field
                label="工作目录（选填）"
                hint="留空使用默认聊天工作区；填绝对路径后，机器人将以此目录执行命令与读写文件"
              >
                <Input
                  className="font-mono"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="/absolute/path/to/project"
                />
              </Field>

              <Field label="访问模式" hint="控制谁可以在飞书中向机器人发起对话">
                <Select
                  aria-label="访问模式"
                  value={accessMode}
                  onValueChange={(v) => setAccessMode(v as LarkAccessMode)}
                  options={[
                    { value: "approval", label: "需要我审批", description: "默认：不在白名单的用户需经管理员审批放行" },
                    { value: "open", label: "开放", description: "群内 @ 或私聊直接对话" },
                  ]}
                />
                <div className="text-label text-ink-muted mt-1.5 leading-relaxed">
                  {accessMode === "approval"
                    ? "审批模式：机器人接入后你自动成为管理员，其他用户发起对话时会向你申请。"
                    : "开放模式：飞书租户内的任何成员都能直接 @ 机器人或私聊。"}
                </div>
              </Field>
            </div>
          </div>
        )}

        {/* ── 第 2 步：扫码确认（Create / Update 共用） ── */}
        {step === 2 && (
          <div className="flex flex-col items-center text-center space-y-4 py-2">
            {/* Update 模式缺权限提醒 */}
            {mode === "update" && bot?.missingScopes && bot.missingScopes.length > 0 && (
              <div className="w-full text-left p-3 rounded-card border border-warn-line bg-warn-muted text-warn-ink text-ui leading-relaxed">
                <div className="font-semibold flex items-center gap-1.5 mb-0.5">
                  <Icon icon={TriangleAlert} size="sm" />
                  待补充的飞书应用权限
                </div>
                <div className="font-mono text-label break-all">
                  {bot.missingScopes.join(", ")}
                </div>
              </div>
            )}

            {/* 扫码指引说明文案 */}
            <div className="text-ui text-ink-muted leading-relaxed max-w-md">
              用飞书手机端扫码，或在已登录飞书的浏览器打开链接；确认页会列出机器人需要的权限。
            </div>

            {/* 状态与倒计时徽标 */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {session?.status === "binding" ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent-muted text-accent-ink border border-accent-line text-ui font-medium">
                  <Spinner size="sm" label={null} />
                  已确认，正在连接…
                </span>
              ) : isExpired ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-danger-muted text-danger-ink border border-danger-line text-ui font-medium">
                  <Icon icon={Hourglass} size="sm" />
                  二维码已过期
                </span>
              ) : isDenied ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-danger-muted text-danger-ink border border-danger-line text-ui font-medium">
                  <Icon icon={Ban} size="sm" />
                  你在飞书取消了
                </span>
              ) : isError ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-danger-muted text-danger-ink border border-danger-line text-ui font-medium">
                  <Icon icon={CircleAlert} size="sm" />
                  发生错误
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-muted text-ink-muted border border-line text-ui">
                    <StatusDot tone="live" />
                    等待你在飞书确认
                  </span>
                  <span className="px-2.5 py-1 rounded-full border border-line bg-surface text-label font-mono text-ink-faint tabular-nums">
                    剩余 {formatCountdown(timeLeft)}
                  </span>
                </>
              )}
            </div>

            {/* 二维码卡片容器（适配手机宽度：移动端以链接为主，二维码居中展示）。
                刻意用 bg-white 而非 surface：二维码必须白底黑码才扫得出，深色皮肤下也一样。 */}
            <div className="relative p-4 rounded-card border border-line bg-white flex flex-col items-center justify-center min-h-[220px] min-w-[220px]">
              {starting ? (
                <div className="flex flex-col items-center justify-center py-8 text-ink-muted gap-2 text-ui">
                  <Spinner label={null} />
                  <span>正在生成飞书授权会话…</span>
                </div>
              ) : qrSvg && !isExpired && !isDenied && !isError ? (
                <div
                  className="w-48 h-48 sm:w-56 sm:h-56 [&>svg]:w-full [&>svg]:h-full"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-6 px-4 text-ink-muted gap-3">
                  {isDenied && <div className="text-danger-ink text-ui font-medium">你在飞书取消了授权</div>}
                  {isExpired && <div className="text-danger-ink text-ui font-medium">二维码已过期，请重新生成</div>}
                  {isError && (
                    <div className="text-danger-ink text-ui font-medium">
                      {session?.error || error || "连接出现异常"}
                    </div>
                  )}
                  {(isExpired || isError) && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => void startRegister(mode)}
                    >
                      <Icon icon={RefreshCw} size="sm" />
                      重新生成二维码
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* 移动端与桌面端快捷链接 */}
            {session?.url && !isExpired && !isDenied && (
              <div className="w-full flex flex-col items-center gap-2 pt-1">
                <Button asChild variant="primary" className="w-full sm:w-auto">
                  <a href={session.url} target="_blank" rel="noreferrer">
                    <Icon icon={Zap} />
                    在浏览器打开确认页
                    <Icon icon={ArrowUpRight} size="sm" />
                  </a>
                </Button>
                <div className="text-label text-ink-faint">
                  手机端可直接点击上方按钮跳转；电脑端可用飞书 App 扫码
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 第 3 步：完成状态（Done） ── */}
        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-card border border-positive-line bg-positive-muted space-y-3">
              <div className="flex items-center gap-2 text-ui font-semibold text-positive-ink">
                <Icon icon={CircleCheck} />
                <span>
                  {mode === "update" ? "配置已更新并重连" : `「${currentBotName}」已创建并连上`}
                </span>
              </div>

              {/* 逐项打勾状态列表 */}
              <div className="divide-y divide-line-faint rounded-card border border-line bg-surface overflow-hidden">
                <div className="px-3.5 py-2.5 flex items-center justify-between text-ui">
                  <span className="text-ink font-medium">长连接就绪</span>
                  {session?.connected ? (
                    <span className="text-positive-ink font-medium flex items-center gap-1 text-label">
                      <Icon icon={Check} size="sm" />
                      已连接
                    </span>
                  ) : (
                    <span className="text-warn-ink flex items-center gap-1 text-label">
                      <Icon icon={Hourglass} size="sm" />
                      等待长连接就绪
                    </span>
                  )}
                </div>

                <div className="px-3.5 py-2.5 flex items-center justify-between text-ui">
                  <span className="text-ink font-medium">管理员权限</span>
                  {session?.adminBound ? (
                    <span className="text-positive-ink font-medium flex items-center gap-1 text-label">
                      <Icon icon={Check} size="sm" />
                      你已是管理员
                    </span>
                  ) : (
                    <span className="text-ink-faint flex items-center gap-1 text-label">
                      — 未自动绑定
                    </span>
                  )}
                </div>

                <div className="px-3.5 py-2.5 flex items-center justify-between text-ui">
                  <span className="text-ink font-medium">初始私聊验证</span>
                  {session?.welcomeSent ? (
                    <span className="text-positive-ink font-medium flex items-center gap-1 text-label">
                      <Icon icon={Check} size="sm" />
                      已给你发了一条私聊
                    </span>
                  ) : (
                    <span className="text-ink-faint flex items-center gap-1 text-label">
                      — 消息发送跳过
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 下一步操作指引 */}
            <div className="p-3.5 rounded-card border border-line bg-surface-muted text-ui space-y-1.5 leading-relaxed">
              <div className="font-semibold text-ink flex items-center gap-1.5">
                <Icon icon={Lightbulb} size="sm" />
                下一步
              </div>
              <div className="text-label text-ink-muted">
                把它拉进飞书群，然后在消息中 <b>@ 它</b> 即可开始对话；也可以在飞书私聊中直接向它发送消息。
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 弹窗底部操作按钮栏 */}
      <div className="px-5 py-3.5 border-t border-line flex items-center justify-between gap-2 shrink-0 bg-surface">
        {step === 1 && (
          <>
            <Button type="button" variant="ghost" size="md" onClick={handleClose}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="md"
              loading={starting}
              disabled={starting || !name.trim()}
              onClick={() => void startRegister("create")}
            >
              下一步：生成二维码
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            {mode === "create" ? (
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setStep(1)}
              >
                上一步：修改信息
              </Button>
            ) : (
              <span className="text-label text-ink-faint">飞书授权会话进行中</span>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={handleClose}
                disabled={session?.status === "binding"}
                title={session?.status === "binding" ? "已确认，正在完成绑定，稍等几秒" : undefined}
              >
                取消
              </Button>
              {(isExpired || isError) && (
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  onClick={() => void startRegister(mode)}
                >
                  重新生成
                </Button>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <div className="w-full flex justify-end">
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={() => {
                onSuccess();
                onClose();
              }}
            >
              完成并返回列表
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
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

