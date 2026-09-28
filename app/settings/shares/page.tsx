"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu, KeyRound, Lock, Plus, RefreshCw, Share2, TriangleAlert, Unplug, X } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Textarea,
  toast,
  useConfirm,
  Spinner,
} from "@/components/ui";
import {
  fetchShares,
  createShare,
  deleteShare,
  subscribeShare,
  unsubscribeShare,
} from "@/lib/gw-client";
import type {
  GwAvailableShare,
  GwShare,
  GwShareType,
  GwSharesResponse,
} from "@/lib/gw-types";

/** /__gw/api/* 只由多租户网关（tenancy/gateway）提供，Next 本身没有这些路由。
 * 直连单人版（不经网关）时请求落到 Next → 404，这不是故障，是「单人版不提供」。 */
function isGatewayAbsent(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404;
}

export default function SharesSettingsPage() {
  const [data, setData] = useState<GwSharesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gatewayError, setGatewayError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const confirm = useConfirm();

  // 发布表单状态
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [shareType, setShareType] = useState<GwShareType>("claude-token");
  const [label, setLabel] = useState("");
  const [visibilityType, setVisibilityType] = useState<"all" | "custom">("all");
  const [customUsers, setCustomUsers] = useState("");

  // claude-token 专属
  const [tokenInput, setTokenInput] = useState("");

  // endpoint 专属
  const [providerName, setProviderName] = useState("");
  const [anthropicUrl, setAnthropicUrl] = useState("");
  const [openaiUrl, setOpenaiUrl] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");

  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  // 保持 .then 链：setState 待在回调里，满足 eslint react-hooks/set-state-in-effect
  const loadData = useCallback((silent = false): Promise<void> => {
    if (!silent) {
      // 仅在非初始挂载的手动触发中调 setLoading
    }
    return fetchShares()
      .then((res) => {
        setData(res);
        setGatewayError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setGatewayError(err ?? new Error("网关不可达"));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const refresh = () => {
    setRefreshing(true);
    void loadData(true).finally(() => setRefreshing(false));
  };

  const handleOpenPublish = () => {
    setLabel("");
    setShareType("claude-token");
    setVisibilityType("all");
    setCustomUsers("");
    setTokenInput("");
    setProviderName("");
    setAnthropicUrl("");
    setOpenaiUrl("");
    setApiKeyEnv("");
    setApiKey("");
    setModelsText("");
    setPublishError(null);
    setPublishModalOpen(true);
  };

  const handlePublishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (publishBusy) return;

    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setPublishError("请输入共享名称/说明");
      return;
    }

    let visibility: "all" | string[] = "all";
    if (visibilityType === "custom") {
      const users = customUsers
        .split(/[\s,，]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      if (users.length === 0) {
        setPublishError("请指定至少一个用户/租户");
        return;
      }
      visibility = users;
    }

    let payload: Record<string, unknown> = {};
    if (shareType === "claude-token") {
      const trimmedToken = tokenInput.trim();
      if (!trimmedToken) {
        setPublishError("请输入 Claude OAuth Token");
        return;
      }
      payload = { token: trimmedToken };
    } else {
      const trimmedProvider = providerName.trim();
      if (!trimmedProvider) {
        setPublishError("请输入服务商名称");
        return;
      }
      const models = modelsText
        .split(/[\n,，]+/)
        .map((m) => m.trim())
        .filter(Boolean);
      if (models.length === 0) {
        setPublishError("请至少填写一个支持的模型名称");
        return;
      }
      payload = {
        name: trimmedProvider,
        anthropic_url: anthropicUrl.trim() || undefined,
        openai_url: openaiUrl.trim() || undefined,
        api_key_env: apiKeyEnv.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        models,
      };
    }

    setPublishBusy(true);
    setPublishError(null);
    try {
      await createShare({
        type: shareType,
        label: trimmedLabel,
        payload,
        visibility,
      });

      // 安全清理：绝不留在内存和输入框中
      setTokenInput("");
      setApiKey("");
      setPublishModalOpen(false);
      toast.success("共享已发布", { description: "凭证明文已加密提交，任何接口都不会回显。" });
      await loadData(true);
    } catch (err) {
      setPublishError(
        err instanceof Error ? err.message : "发布失败，请重试",
      );
    } finally {
      setPublishBusy(false);
    }
  };

  const handleRevokeShare = async (share: GwShare) => {
    const ok = await confirm({
      title: `撤销共享「${share.label}」？`,
      description:
        "所有已订阅用户的凭据注入会一并移除。撤销只能停止后续注入，已经被取走的凭据召不回来。",
      confirmLabel: "撤销共享",
      danger: true,
    });
    if (!ok) return;

    setActionBusyId(share.id);
    try {
      await deleteShare(share.id);
      toast.success(`已撤销共享「${share.label}」`, { description: "订阅方的凭据注入已一并移除。" });
      await loadData(true);
    } catch (err) {
      toast.error("撤销失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setActionBusyId(null);
    }
  };

  const executeSubscribe = async (share: GwAvailableShare) => {
    setActionBusyId(share.id);
    try {
      const res = await subscribeShare(share.id);
      if (res.willRestart) {
        toast.warning(`已订阅「${share.label}」`, {
          description: "租户容器正在重启以应用凭据，请稍候。",
        });
      } else {
        toast.success(`已订阅「${share.label}」`, {
          description: "端点已写入你的 endpoints.yaml。",
        });
      }
      await loadData(true);
    } catch (err) {
      toast.error("订阅失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setActionBusyId(null);
    }
  };

  // Claude Token 订阅会替换现有凭据并重启租户容器 —— 先确认。
  const handleSubscribeClick = async (share: GwAvailableShare) => {
    if (share.type === "claude-token") {
      const ok = await confirm({
        title: `订阅 Claude Token「${share.label}」？`,
        description: `会替换你当前已激活的 Claude Code 凭据，并重启租户容器以应用配置。发布者：${share.owner}。`,
        confirmLabel: "订阅并重启容器",
      });
      if (!ok) return;
    }
    void executeSubscribe(share);
  };

  const handleUnsubscribe = async (share: GwAvailableShare) => {
    const ok = await confirm({
      title: `退订「${share.label}」？`,
      description:
        share.type === "claude-token"
          ? "注入的 Claude Token 会被移除，租户容器会重启清理。"
          : "这个端点会从你的 endpoints.yaml 里移除。",
      confirmLabel: "退订",
      danger: true,
    });
    if (!ok) return;

    setActionBusyId(share.id);
    try {
      const res = await unsubscribeShare(share.id);
      if (res.willRestart) {
        toast.warning(`已退订「${share.label}」`, { description: "容器正在重启清理注入。" });
      } else {
        toast.success(`已退订「${share.label}」`, { description: "已从 endpoints.yaml 移除。" });
      }
      await loadData(true);
    } catch (err) {
      toast.error("退订失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setActionBusyId(null);
    }
  };

  const gatewayAbsent = gatewayError !== null && isGatewayAbsent(gatewayError);
  const visibilityText = (v: GwShare["visibility"], long: boolean) =>
    v === "all"
      ? long ? "全员可见" : "全员"
      : Array.isArray(v)
        ? long ? `指定用户（${v.join(", ")}）` : `${v.length} 位用户`
        : "指定";

  const listSkeleton = (
    <div role="status" aria-label="加载中" className="rounded-card border border-line bg-surface divide-y divide-line-faint">
      {[0, 1].map((i) => (
        <div key={i} className="px-4 py-3 flex flex-col gap-2">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="共享池"
        count={data ? data.available.length : undefined}
        countUnit="个可用共享"
        subtitle={data ? `我发布了 ${data.published.length} 个` : "发布与订阅 Claude Token 或大模型 API 端点"}
        actions={
          <>
            <IconButton label="刷新" onClick={refresh} disabled={refreshing || loading}>
              {refreshing ? <Spinner label={null} /> : <Icon icon={RefreshCw} />}
            </IconButton>
            <Button variant="primary" onClick={handleOpenPublish} disabled={gatewayError !== null}>
              <Icon icon={Plus} />
              发布共享
            </Button>
          </>
        }
      />

      {/* 永久明示安全警示卡片 */}
      <div className="rounded-card border border-warn-line bg-warn-muted px-3.5 py-3 text-ui text-warn-ink flex items-start gap-2.5">
        <Icon icon={TriangleAlert} className="mt-0.5" />
        <div className="leading-relaxed">
          <span className="font-semibold">安全须知：共享 = 交出。</span>
          订阅方容器内所有进程均可提取凭证明文；撤销仅保证停止后续注入，不能召回已泄出的凭据。请仅在信任的团队内共享。
        </div>
      </div>

      {/* 直连单人版：没有网关，/__gw/api/* 落到 Next 返回 404 —— 这是「不提供」，不是故障。 */}
      {gatewayAbsent && (
        <EmptyState
          icon={Unplug}
          title="单人版不提供共享池"
          description="模型与凭证共享只在经多租户网关访问时可用；当前是直连的单人版。"
          className="rounded-card border border-line"
        />
      )}

      {gatewayError !== null && !gatewayAbsent && (
        <ErrorCallout
          error={gatewayError}
          title="连不上多租户网关"
          hint="共享池由多租户网关提供。确认网关在运行、且是经网关地址访问的，然后重试。"
          onRetry={() => void loadData()}
        />
      )}

      {gatewayError === null && (
        <>
          {/* Section 1: 可用共享 */}
          <section>
            <div className="mb-2">
              <h2 className="text-ui font-semibold text-ink-strong">可用共享（他人发布）</h2>
              <p className="text-label text-ink-muted">其他成员共享给你的 Claude Token 或 API 端点</p>
            </div>

            {loading && !data ? (
              listSkeleton
            ) : data?.available.length === 0 ? (
              <EmptyState
                compact
                icon={Share2}
                title="还没有对你可见的共享"
                description="其他成员发布并对你可见后，会出现在这里。"
                className="rounded-card border border-line"
              />
            ) : (
              <div className="rounded-card border border-line bg-surface divide-y divide-line-faint">
                {data?.available.map((item) => {
                  const busy = actionBusyId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-ui font-medium text-ink-strong">{item.label}</span>
                          <Badge variant={item.type === "claude-token" ? "accent" : "neutral"}>
                            {item.type === "claude-token" ? "Claude Token" : "API 端点"}
                          </Badge>
                          {item.subscribed && <Badge variant="positive">已订阅</Badge>}
                        </div>
                        <div className="text-label text-ink-muted mt-1 flex items-center gap-x-2 flex-wrap">
                          <span>发布者 {item.owner}</span>
                          <span className="text-ink-faint">·</span>
                          <span>可见范围 {visibilityText(item.visibility, false)}</span>
                          <span className="text-ink-faint">·</span>
                          <span className="tabular-nums">{item.subscriberCount} 人订阅</span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        {item.subscribed ? (
                          <Button size="sm" onClick={() => void handleUnsubscribe(item)} loading={busy}>
                            退订
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => void handleSubscribeClick(item)}
                            loading={busy}
                          >
                            订阅并注入
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Section 2: 我发布的 */}
          <section>
            <div className="mb-2">
              <h2 className="text-ui font-semibold text-ink-strong">我发布的共享</h2>
              <p className="text-label text-ink-muted">你提供给团队成员使用的凭证（凭证明文绝不回显）</p>
            </div>

            {loading && !data ? (
              listSkeleton
            ) : data?.published.length === 0 ? (
              <EmptyState
                compact
                icon={Share2}
                title="还没有发布过共享"
                description="把自己的 Claude Token 或 API 端点共享给信任的团队成员。"
                action={
                  <Button size="sm" onClick={handleOpenPublish}>
                    <Icon icon={Plus} size="sm" />
                    发布共享
                  </Button>
                }
                className="rounded-card border border-line"
              />
            ) : (
              <div className="rounded-card border border-line bg-surface divide-y divide-line-faint">
                {data?.published.map((item) => {
                  const busy = actionBusyId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-ui font-medium text-ink-strong">{item.label}</span>
                          <Badge variant={item.type === "claude-token" ? "accent" : "neutral"}>
                            {item.type === "claude-token" ? "Claude Token" : "API 端点"}
                          </Badge>
                        </div>
                        <div className="text-label text-ink-muted mt-1 flex items-center gap-x-2 flex-wrap">
                          <span>{visibilityText(item.visibility, true)}</span>
                          <span className="text-ink-faint">·</span>
                          <span className="tabular-nums">{item.subscriberCount} 人订阅</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void handleRevokeShare(item)}
                          loading={busy}
                        >
                          撤销共享
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* 发布共享 Modal */}
      {publishModalOpen && (
        <Modal
          onClose={() => !publishBusy && setPublishModalOpen(false)}
          size="lg"
          title="发布新凭证共享"
          panelClassName="p-5 flex flex-col max-h-[90vh]"
        >
          <div className="flex items-center justify-between pb-3 border-b border-line">
            <h3 className="text-body font-semibold text-ink-strong">发布新凭证共享</h3>
            <IconButton
              label="关闭"
              size="sm"
              onClick={() => setPublishModalOpen(false)}
              disabled={publishBusy}
            >
              <Icon icon={X} size="sm" />
            </IconButton>
          </div>

          <form onSubmit={handlePublishSubmit} className="overflow-y-auto py-4 flex flex-col gap-4 flex-1">
            {publishError && (
              <ErrorCallout compact error="" title={publishError} hint="改好后再点确认发布。" />
            )}

            <FormField label="共享名称 / 描述" required>
              <Input
                value={label}
                placeholder="例如：个人自用 Claude Token / 团队 DeepSeek V3 额度"
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </FormField>

            <FormField label="凭据类型" required>
              <div role="radiogroup" aria-label="凭据类型" className="grid grid-cols-2 gap-2">
                {(
                  [
                    {
                      value: "claude-token",
                      icon: KeyRound,
                      title: "Claude Token",
                      desc: "订阅后写入租户容器环境并自动重启生效",
                    },
                    {
                      value: "endpoint",
                      icon: Cpu,
                      title: "大模型 API 端点",
                      desc: "写入租户 endpoints.yaml 的标记块，无需重启",
                    },
                  ] as const
                ).map((opt) => {
                  const on = shareType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setShareType(opt.value)}
                      className={`p-3 rounded-card border text-left transition-colors duration-100 ${
                        on
                          ? "border-accent-line bg-accent-muted text-accent-ink"
                          : "border-line bg-surface hover:bg-surface-hover text-ink"
                      }`}
                    >
                      <div className="text-ui font-semibold flex items-center gap-1.5">
                        <Icon icon={opt.icon} size="sm" selected={on} />
                        {opt.title}
                      </div>
                      <div className="text-label text-ink-muted mt-1">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </FormField>

            {/* Type 1: Claude Token */}
            {shareType === "claude-token" && (
              <div className="rounded-card border border-line p-3.5 flex flex-col gap-2">
                <FormField label="OAuth Token" required>
                  <Input
                    type="password"
                    autoComplete="off"
                    className="font-mono"
                    value={tokenInput}
                    placeholder="claude setup-token 产出的凭证明文"
                    onChange={(e) => setTokenInput(e.target.value)}
                    required
                  />
                </FormField>
                <div className="text-label text-ink-faint leading-relaxed">
                  在终端运行 <code className="font-mono">claude setup-token</code> 完成授权即可拿到。每位用户同一时间只能激活一个 Claude Token 订阅。
                </div>
              </div>
            )}

            {/* Type 2: API Endpoint */}
            {shareType === "endpoint" && (
              <div className="rounded-card border border-line p-3.5 flex flex-col gap-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <FormField label="服务商名称" required>
                    <Input
                      value={providerName}
                      placeholder="deepseek / kimi / qwen"
                      onChange={(e) => setProviderName(e.target.value)}
                      required
                    />
                  </FormField>
                  <FormField label="环境变量名（可选）">
                    <Input
                      className="font-mono"
                      value={apiKeyEnv}
                      placeholder="DEEPSEEK_API_KEY"
                      onChange={(e) => setApiKeyEnv(e.target.value)}
                    />
                  </FormField>
                </div>

                <FormField label="Anthropic 兼容端点（走 Claude CLI 必填）">
                  <Input
                    className="font-mono"
                    value={anthropicUrl}
                    placeholder="https://api.deepseek.com/anthropic"
                    onChange={(e) => setAnthropicUrl(e.target.value)}
                  />
                </FormField>

                <FormField label="OpenAI 兼容端点（走 Responses API / Codex）">
                  <Input
                    className="font-mono"
                    value={openaiUrl}
                    placeholder="https://api.deepseek.com/v1"
                    onChange={(e) => setOpenaiUrl(e.target.value)}
                  />
                </FormField>

                <FormField label="API Key 明文">
                  <Input
                    type="password"
                    autoComplete="off"
                    className="font-mono"
                    value={apiKey}
                    placeholder="sk-..."
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </FormField>

                <FormField label="支持的模型列表" required hint="每行一个模型名称，或用逗号分隔">
                  <Textarea
                    className="h-20 font-mono"
                    value={modelsText}
                    placeholder={"deepseek-chat\ndeepseek-reasoner"}
                    onChange={(e) => setModelsText(e.target.value)}
                    required
                  />
                </FormField>
              </div>
            )}

            {/* 可见范围 */}
            <FormField label="可见范围" required>
              <SegmentedControl
                aria-label="可见范围"
                value={visibilityType}
                onValueChange={setVisibilityType}
                options={[
                  { value: "all", label: "全员可见" },
                  { value: "custom", label: "指定用户" },
                ]}
              />
              {visibilityType === "custom" && (
                <div className="mt-2 flex flex-col gap-1">
                  <Input
                    value={customUsers}
                    placeholder="输入用户名，用逗号或空格分隔（如 alice, bob）"
                    onChange={(e) => setCustomUsers(e.target.value)}
                    required
                  />
                  <div className="text-label text-ink-faint">
                    只有被指定的用户能在「可用共享」里看到并订阅
                  </div>
                </div>
              )}
            </FormField>

            <div className="flex items-start gap-2 text-label text-warn-ink bg-warn-muted px-3 py-2 rounded-card border border-warn-line">
              <Icon icon={Lock} size="sm" className="mt-px" />
              提交后明文凭据由网关加密入库，前端立即清空输入，任何接口都不会回显明文。
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button
                type="button"
                variant="ghost"
                disabled={publishBusy}
                onClick={() => setPublishModalOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" loading={publishBusy}>
                确认发布
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function FormField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label text-ink-muted">
        {label}
        {required && <span className="ml-0.5 text-danger-ink">*</span>}
      </span>
      {children}
      {hint && <span className="text-label text-ink-faint">{hint}</span>}
    </div>
  );
}
