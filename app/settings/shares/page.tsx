"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
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

const FIELD =
  "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";

export default function SharesSettingsPage() {
  const [data, setData] = useState<GwSharesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "positive" | "warn" | "danger";
    message: string;
  } | null>(null);

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

  // 订阅确认弹窗（特别针对 willRestart 的 claude-token）
  const [pendingSubscribeShare, setPendingSubscribeShare] =
    useState<GwAvailableShare | null>(null);
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
      .catch((err) => {
        setGatewayError(
          err instanceof Error
            ? err.message
            : "未启用多租户网关服务（接口不可达）",
        );
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

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
        setPublishError("请输入 Provider 名称");
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
      setFeedback({
        tone: "positive",
        message: "共享发布成功！凭证明文已安全加密提交。",
      });
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
    if (
      !window.confirm(
        `确定撤销共享「${share.label}」？\n\n注意：撤销将级联移除所有已订阅用户的凭据注入。`,
      )
    ) {
      return;
    }

    setActionBusyId(share.id);
    try {
      await deleteShare(share.id);
      setFeedback({
        tone: "positive",
        message: `已撤销共享「${share.label}」并级联移除订阅注入。`,
      });
      await loadData(true);
    } catch (err) {
      setFeedback({
        tone: "danger",
        message: err instanceof Error ? err.message : "撤销失败",
      });
    } finally {
      setActionBusyId(null);
    }
  };

  const executeSubscribe = async (share: GwAvailableShare) => {
    setActionBusyId(share.id);
    setPendingSubscribeShare(null);
    try {
      const res = await subscribeShare(share.id);
      if (res.willRestart) {
        setFeedback({
          tone: "warn",
          message: `订阅「${share.label}」成功！已触发租户容器重启以应用凭据，请稍候…`,
        });
      } else {
        setFeedback({
          tone: "positive",
          message: `订阅「${share.label}」成功！端点已注入您的 endpoints.yaml。`,
        });
      }
      await loadData(true);
    } catch (err) {
      setFeedback({
        tone: "danger",
        message: err instanceof Error ? err.message : "订阅失败",
      });
    } finally {
      setActionBusyId(null);
    }
  };

  const handleSubscribeClick = (share: GwAvailableShare) => {
    if (share.type === "claude-token") {
      setPendingSubscribeShare(share);
    } else {
      void executeSubscribe(share);
    }
  };

  const handleUnsubscribe = async (share: GwAvailableShare) => {
    if (!window.confirm(`确定退订「${share.label}」？`)) return;

    setActionBusyId(share.id);
    try {
      const res = await unsubscribeShare(share.id);
      if (res.willRestart) {
        setFeedback({
          tone: "warn",
          message: `已退订「${share.label}」，容器正在重启清理注入…`,
        });
      } else {
        setFeedback({
          tone: "positive",
          message: `已退订「${share.label}」，已从 endpoints.yaml 移除标记块。`,
        });
      }
      await loadData(true);
    } catch (err) {
      setFeedback({
        tone: "danger",
        message: err instanceof Error ? err.message : "退订失败",
      });
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {/* 永久明示安全警示卡片 */}
      <div className="rounded-card border border-warn-line bg-warn-muted p-3.5 text-ui text-warn-ink flex items-start gap-2.5">
        <span className="text-base shrink-0 leading-tight">⚠️</span>
        <div className="text-reading leading-relaxed">
          <span className="font-semibold">安全须知：共享 = 交出。</span>
          订阅方容器内所有进程均可提取凭证明文；撤销仅保证停止后续注入，不能召回已泄出的凭据。请仅在信任的团队内共享。
        </div>
      </div>

      {feedback && (
        <div
          className={`px-3 py-2 rounded-md border text-ui flex items-center justify-between ${
            feedback.tone === "positive"
              ? "bg-positive-muted text-positive-ink border-positive-line"
              : feedback.tone === "warn"
                ? "bg-warn-muted text-warn-ink border-warn-line"
                : "bg-danger-muted text-danger-ink border-danger-line"
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-label ml-2 underline hover:opacity-75"
          >
            关闭
          </button>
        </div>
      )}

      {/* 网关不可达/单人模式静默降级提示 */}
      {gatewayError && (
        <div className="rounded-card border border-line bg-surface-muted/60 p-5 text-center">
          <div className="text-2xl mb-2">🔌</div>
          <div className="text-ui font-medium text-ink-strong mb-1">
            未启用多租户网关服务
          </div>
          <div className="text-label text-ink-muted max-w-md mx-auto">
            当前处于独立单人版模式或网关不可达（{gatewayError}）。
            模型共享与凭证互助功能仅在多租户网关代理环境下可用。
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => void loadData()}
            disabled={loading}
          >
            重试连接
          </Button>
        </div>
      )}

      {!gatewayError && (
        <>
          {/* Section 1: 可用共享 */}
          <section className="rounded-card border border-line bg-surface shadow-raise p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-ui font-semibold text-ink-strong">
                  可用共享 (他人发布)
                </h2>
                <p className="text-label text-ink-faint">
                  其他成员共享给你的 Claude Token 或 API 端点
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadData(true)}
                disabled={loading}
              >
                刷新
              </Button>
            </div>

            {loading && !data ? (
              <div className="py-6 text-center text-label text-ink-faint">
                加载共享池中…
              </div>
            ) : data?.available.length === 0 ? (
              <div className="py-6 text-center text-label text-ink-faint bg-surface-muted/30 rounded-lg border border-line-faint">
                当前没有对你可见的共享凭证
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-line-faint">
                {data?.available.map((item) => {
                  const busy = actionBusyId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-ui font-medium text-ink-strong">
                            {item.label}
                          </span>
                          <Pill
                            tone={
                              item.type === "claude-token"
                                ? "accent"
                                : "neutral"
                            }
                          >
                            {item.type === "claude-token"
                              ? "Claude Token"
                              : "API 端点"}
                          </Pill>
                          {item.subscribed && (
                            <Pill tone="positive">✓ 已激活订阅</Pill>
                          )}
                        </div>

                        <div className="text-label text-ink-faint mt-1 flex items-center gap-3 flex-wrap">
                          <span>发布者: {item.owner}</span>
                          <span>·</span>
                          <span>
                            可见范围:{" "}
                            {item.visibility === "all"
                              ? "全员"
                              : Array.isArray(item.visibility)
                                ? `${item.visibility.length} 位租户`
                                : "指定"}
                          </span>
                          <span>·</span>
                          <span>订阅人数: {item.subscriberCount}</span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        {item.subscribed ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleUnsubscribe(item)}
                            loading={busy}
                          >
                            退订
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => handleSubscribeClick(item)}
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
          <section className="rounded-card border border-line bg-surface shadow-raise p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-ui font-semibold text-ink-strong">
                  我发布的共享
                </h2>
                <p className="text-label text-ink-faint">
                  你提供给团队成员使用的凭证（凭证明文绝不回显）
                </p>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={handleOpenPublish}
              >
                + 发布共享
              </Button>
            </div>

            {loading && !data ? (
              <div className="py-6 text-center text-label text-ink-faint">
                加载中…
              </div>
            ) : data?.published.length === 0 ? (
              <div className="py-6 text-center text-label text-ink-faint bg-surface-muted/30 rounded-lg border border-line-faint">
                你尚未发布过任何共享凭证
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-line-faint">
                {data?.published.map((item) => {
                  const busy = actionBusyId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-ui font-medium text-ink-strong">
                            {item.label}
                          </span>
                          <Pill
                            tone={
                              item.type === "claude-token"
                                ? "accent"
                                : "neutral"
                            }
                          >
                            {item.type === "claude-token"
                              ? "Claude Token"
                              : "API 端点"}
                          </Pill>
                        </div>
                        <div className="text-label text-ink-faint mt-1 flex items-center gap-3 flex-wrap">
                          <span>
                            可见范围:{" "}
                            {item.visibility === "all"
                              ? "全员可见"
                              : Array.isArray(item.visibility)
                                ? `指定用户 (${item.visibility.join(", ")})`
                                : "指定"}
                          </span>
                          <span>·</span>
                          <span>已订阅用户数: {item.subscriberCount}</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:bg-danger-muted"
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
          panelClassName="p-5 flex flex-col max-h-[90vh]"
        >
          <div className="flex items-center justify-between pb-3 border-b border-line">
            <h3 className="text-base font-semibold text-ink-strong">
              发布新凭证共享
            </h3>
            <button
              type="button"
              onClick={() => setPublishModalOpen(false)}
              disabled={publishBusy}
              className="text-ink-muted hover:text-ink text-sm"
            >
              ✕
            </button>
          </div>

          <form
            onSubmit={handlePublishSubmit}
            className="overflow-y-auto py-4 space-y-4 flex-1"
          >
            {publishError && (
              <div className="p-2.5 rounded-md border border-danger-line bg-danger-muted text-danger-ink text-ui">
                {publishError}
              </div>
            )}

            <div>
              <label className="text-label text-ink-muted block mb-1">
                共享名称 / 描述 <span className="text-danger">*</span>
              </label>
              <input
                className={FIELD}
                value={label}
                placeholder="例如：个人自用 Claude Token / 团队 DeepSeek V3 额度"
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="text-label text-ink-muted block mb-1.5">
                凭据类型 <span className="text-danger">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setShareType("claude-token")}
                  className={`p-3 rounded-card border text-left transition-colors ${
                    shareType === "claude-token"
                      ? "border-accent-line bg-accent-muted/60 text-accent-ink"
                      : "border-line bg-surface hover:bg-surface-muted text-ink"
                  }`}
                >
                  <div className="text-ui font-semibold flex items-center gap-1.5">
                    <span>🔑</span>
                    <span>Claude Token</span>
                  </div>
                  <div className="text-nano text-ink-muted mt-1">
                    订阅后将写入租户容器环境并自动重启生效
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setShareType("endpoint")}
                  className={`p-3 rounded-card border text-left transition-colors ${
                    shareType === "endpoint"
                      ? "border-accent-line bg-accent-muted/60 text-accent-ink"
                      : "border-line bg-surface hover:bg-surface-muted text-ink"
                  }`}
                >
                  <div className="text-ui font-semibold flex items-center gap-1.5">
                    <span>🧠</span>
                    <span>大模型 API 端点</span>
                  </div>
                  <div className="text-nano text-ink-muted mt-1">
                    注入到租户 endpoints.yaml 标记块，无需重启
                  </div>
                </button>
              </div>
            </div>

            {/* Type 1: Claude Token */}
            {shareType === "claude-token" && (
              <div className="rounded-lg border border-line bg-surface-muted/40 p-3.5 space-y-2">
                <label className="text-label text-ink-muted block">
                  OAuth Token <span className="text-danger">*</span>
                </label>
                <input
                  className={FIELD}
                  type="password"
                  autoComplete="off"
                  value={tokenInput}
                  placeholder="claude setup-token 产出的凭证明文"
                  onChange={(e) => setTokenInput(e.target.value)}
                  required
                />
                <div className="text-nano text-ink-faint leading-relaxed">
                  提示：可在终端运行 <code>claude setup-token</code> 完成授权获取 token。每位租户同一时间仅可激活一个 Claude Token 订阅。
                </div>
              </div>
            )}

            {/* Type 2: API Endpoint */}
            {shareType === "endpoint" && (
              <div className="rounded-lg border border-line bg-surface-muted/40 p-3.5 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-label text-ink-muted block mb-1">
                      Provider 名称 <span className="text-danger">*</span>
                    </label>
                    <input
                      className={FIELD}
                      value={providerName}
                      placeholder="deepseek / kimi / qwen"
                      onChange={(e) => setProviderName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-label text-ink-muted block mb-1">
                      环境变量名 (可选)
                    </label>
                    <input
                      className={FIELD}
                      value={apiKeyEnv}
                      placeholder="DEEPSEEK_API_KEY"
                      onChange={(e) => setApiKeyEnv(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-label text-ink-muted block mb-1">
                    Anthropic 兼容端点 (走 Claude CLI 必填)
                  </label>
                  <input
                    className={FIELD}
                    value={anthropicUrl}
                    placeholder="https://api.deepseek.com/anthropic"
                    onChange={(e) => setAnthropicUrl(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-label text-ink-muted block mb-1">
                    OpenAI 兼容端点 (走 Responses API / Codex)
                  </label>
                  <input
                    className={FIELD}
                    value={openaiUrl}
                    placeholder="https://api.deepseek.com/v1"
                    onChange={(e) => setOpenaiUrl(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-label text-ink-muted block mb-1">
                    API Key 明文
                  </label>
                  <input
                    className={FIELD}
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    placeholder="sk-..."
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-label text-ink-muted block mb-1">
                    支持的模型列表 <span className="text-danger">*</span>
                  </label>
                  <textarea
                    className={`${FIELD} h-20 font-mono`}
                    value={modelsText}
                    placeholder={"deepseek-chat\ndeepseek-reasoner"}
                    onChange={(e) => setModelsText(e.target.value)}
                    required
                  />
                  <div className="text-nano text-ink-faint mt-0.5">
                    每行一个模型名称，或用逗号分隔
                  </div>
                </div>
              </div>
            )}

            {/* 可见范围 */}
            <div>
              <label className="text-label text-ink-muted block mb-1.5">
                可见范围 <span className="text-danger">*</span>
              </label>
              <div className="flex items-center gap-4 mb-2 text-ui">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibilityType === "all"}
                    onChange={() => setVisibilityType("all")}
                  />
                  <span>全员可见</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibilityType === "custom"}
                    onChange={() => setVisibilityType("custom")}
                  />
                  <span>指定租户 / 用户</span>
                </label>
              </div>

              {visibilityType === "custom" && (
                <div>
                  <input
                    className={FIELD}
                    value={customUsers}
                    placeholder="输入用户名/租户名，用逗号或空格分隔（如 alice, bob）"
                    onChange={(e) => setCustomUsers(e.target.value)}
                    required
                  />
                  <div className="text-nano text-ink-faint mt-1">
                    仅被指定的用户可在「可用共享」中看到并订阅此凭证
                  </div>
                </div>
              )}
            </div>

            <div className="text-nano text-warn-ink bg-warn-muted/50 p-2.5 rounded border border-warn-line/50">
              🔒 提交后明文凭据将由网关安全入库，前端立即清理输入，任何接口均不会回显明文。
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
              <Button
                type="submit"
                variant="primary"
                loading={publishBusy}
              >
                确认发布
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Claude Token 订阅确认弹窗 */}
      {pendingSubscribeShare && (
        <Modal
          onClose={() => setPendingSubscribeShare(null)}
          size="md"
          panelClassName="p-5"
        >
          <div className="text-base font-semibold text-ink-strong mb-2 flex items-center gap-2">
            <span>⚠️</span>
            <span>确认订阅 Claude Token</span>
          </div>
          <div className="text-ui text-ink leading-relaxed mb-4">
            订阅「
            <span className="font-semibold">
              {pendingSubscribeShare.label}
            </span>
            」将替换您当前已激活的 Claude Code 凭据，并
            <span className="font-semibold text-warn-ink">
              触发租户容器重启
            </span>
            以应用配置。
            <div className="mt-2 text-label text-ink-faint">
              发布者：{pendingSubscribeShare.owner}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setPendingSubscribeShare(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void executeSubscribe(pendingSubscribeShare)}
            >
              确认并重启容器
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
