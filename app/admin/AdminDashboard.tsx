"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import {
  fetchAdminUsers,
  enableAdminUser,
  disableAdminUser,
  restartAdminUser,
  fetchAdminInvites,
  createAdminInvite,
  deleteAdminInvite,
  fetchShares,
} from "@/lib/gw-client";
import type {
  GwAdminUser,
  GwInvite,
  GwInviteCreateResponse,
  GwShare,
} from "@/lib/gw-types";

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "-";
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

export function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<"users" | "invites" | "shares">(
    "users",
  );

  // 用户表状态
  const [users, setUsers] = useState<GwAdminUser[] | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userActionBusy, setUserActionBusy] = useState<string | null>(null);

  // 邀请码状态
  const [invites, setInvites] = useState<GwInvite[] | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [inviteActionBusy, setInviteActionBusy] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] =
    useState<GwInviteCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // 共享池状态
  const [shares, setShares] = useState<GwShare[] | null>(null);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);

  // 全局通知/反馈
  const [toast, setToast] = useState<{
    type: "positive" | "warn" | "danger";
    text: string;
  } | null>(null);

  // 保持 .then 链：setState 待在回调里，满足 eslint react-hooks/set-state-in-effect
  const loadUsers = useCallback((): Promise<void> => {
    return fetchAdminUsers()
      .then((data) => {
        setUsers(data);
        setUsersError(null);
        setUsersLoading(false);
      })
      .catch((err) => {
        setUsersError(
          err instanceof Error ? err.message : "无法加载用户列表",
        );
        setUsersLoading(false);
      });
  }, []);

  const loadInvites = useCallback((): Promise<void> => {
    return fetchAdminInvites()
      .then((data) => {
        setInvites(data);
        setInvitesError(null);
        setInvitesLoading(false);
      })
      .catch((err) => {
        setInvitesError(
          err instanceof Error ? err.message : "无法加载邀请码列表",
        );
        setInvitesLoading(false);
      });
  }, []);

  const loadShares = useCallback((): Promise<void> => {
    return fetchShares()
      .then((data) => {
        // 合并去重全部已发布和可用的共享
        const map = new Map<string, GwShare>();
        for (const s of data.published) map.set(s.id, s);
        for (const s of data.available) map.set(s.id, s);
        setShares(Array.from(map.values()));
        setSharesError(null);
        setSharesLoading(false);
      })
      .catch((err) => {
        setSharesError(
          err instanceof Error ? err.message : "无法加载共享池列表",
        );
        setSharesLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadUsers();
    void loadInvites();
    void loadShares();
  }, [loadUsers, loadInvites, loadShares]);

  const handleToggleUserDisabled = async (user: GwAdminUser) => {
    const action = user.disabled ? "启用" : "禁用";
    if (
      !window.confirm(
        `确定${action}用户「${user.name}」？${
          !user.disabled ? "\n禁用后该用户的 Session 将即时失效。" : ""
        }`,
      )
    ) {
      return;
    }

    setUserActionBusy(user.name);
    try {
      if (user.disabled) {
        await enableAdminUser(user.name);
        setToast({ type: "positive", text: `已成功启用用户「${user.name}」` });
      } else {
        await disableAdminUser(user.name);
        setToast({ type: "warn", text: `已成功禁用用户「${user.name}」` });
      }
      await loadUsers();
    } catch (err) {
      setToast({
        type: "danger",
        text: err instanceof Error ? err.message : `${action}失败`,
      });
    } finally {
      setUserActionBusy(null);
    }
  };

  const handleRestartUser = async (user: GwAdminUser) => {
    if (user.container.state === "host") return;
    if (
      !window.confirm(
        `确定重启用户「${user.name}」的租户容器？\n重启过程中该用户连接将短暂中断。`,
      )
    ) {
      return;
    }

    setUserActionBusy(user.name);
    try {
      await restartAdminUser(user.name);
      setToast({
        type: "positive",
        text: `已发送重启指令，用户「${user.name}」的容器正在重启中。`,
      });
      await loadUsers();
    } catch (err) {
      setToast({
        type: "danger",
        text: err instanceof Error ? err.message : "重启容器失败",
      });
    } finally {
      setUserActionBusy(null);
    }
  };

  const handleCreateInvite = async () => {
    setInviteActionBusy("create");
    try {
      const res = await createAdminInvite();
      setCreatedInvite(res);
      setCopied(false);
      setToast({ type: "positive", text: "邀请码生成成功！" });
      await loadInvites();
    } catch (err) {
      setToast({
        type: "danger",
        text: err instanceof Error ? err.message : "生成邀请码失败",
      });
    } finally {
      setInviteActionBusy(null);
    }
  };

  const handleDeleteInvite = async (code: string) => {
    if (!window.confirm(`确定作废邀请码「${code}」？`)) return;

    setInviteActionBusy(code);
    try {
      await deleteAdminInvite(code);
      setToast({ type: "positive", text: "邀请码已作废" });
      await loadInvites();
    } catch (err) {
      setToast({
        type: "danger",
        text: err instanceof Error ? err.message : "作废邀请码失败",
      });
    } finally {
      setInviteActionBusy(null);
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // clipboard fallback
    }
  };

  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-ui text-ink-muted hover:text-ink">
            ← 返回
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Trellis 管理控制台</h1>
            <Pill tone="accent">🛡️ 管理员专属</Pill>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/settings"
            className="text-label text-ink-muted hover:text-ink"
          >
            系统设置 →
          </Link>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto p-4 flex flex-col gap-5">
        {toast && (
          <div
            className={`px-3.5 py-2.5 rounded-md border text-ui flex items-center justify-between shadow-sm ${
              toast.type === "positive"
                ? "bg-positive-muted text-positive-ink border-positive-line"
                : toast.type === "warn"
                  ? "bg-warn-muted text-warn-ink border-warn-line"
                  : "bg-danger-muted text-danger-ink border-danger-line"
            }`}
          >
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-label ml-3 underline hover:opacity-75"
            >
              关闭
            </button>
          </div>
        )}

        {/* Tab 导航 */}
        <div className="flex border-b border-line gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("users")}
            className={`px-4 py-2 text-ui font-medium border-b-2 transition-colors -mb-px flex items-center gap-1.5 ${
              activeTab === "users"
                ? "border-accent text-accent-ink font-semibold"
                : "border-transparent text-ink-muted hover:text-ink hover:border-line"
            }`}
          >
            <span>👥</span>
            <span>用户与容器管理</span>
            {users && (
              <span className="text-nano px-1.5 py-0.5 rounded-full bg-surface-muted text-ink-faint">
                {users.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("invites")}
            className={`px-4 py-2 text-ui font-medium border-b-2 transition-colors -mb-px flex items-center gap-1.5 ${
              activeTab === "invites"
                ? "border-accent text-accent-ink font-semibold"
                : "border-transparent text-ink-muted hover:text-ink hover:border-line"
            }`}
          >
            <span>🎫</span>
            <span>邀请码发放</span>
            {invites && (
              <span className="text-nano px-1.5 py-0.5 rounded-full bg-surface-muted text-ink-faint">
                {invites.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("shares")}
            className={`px-4 py-2 text-ui font-medium border-b-2 transition-colors -mb-px flex items-center gap-1.5 ${
              activeTab === "shares"
                ? "border-accent text-accent-ink font-semibold"
                : "border-transparent text-ink-muted hover:text-ink hover:border-line"
            }`}
          >
            <span>🤝</span>
            <span>共享池总览 (只读)</span>
            {shares && (
              <span className="text-nano px-1.5 py-0.5 rounded-full bg-surface-muted text-ink-faint">
                {shares.length}
              </span>
            )}
          </button>
        </div>

        {/* Tab 1: 用户表 */}
        {activeTab === "users" && (
          <section className="rounded-card border border-line bg-surface shadow-raise p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-ui font-semibold text-ink-strong">
                  租户与用户列表
                </h2>
                <p className="text-label text-ink-faint">
                  查看全量注册用户、角色划分、隔离容器运行态及健康检查
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={loadUsers}
                disabled={usersLoading}
              >
                刷新列表
              </Button>
            </div>

            {usersError && (
              <div className="p-4 rounded-lg border border-warn-line bg-warn-muted/50 text-warn-ink text-ui flex items-start gap-2">
                <span>⚠️</span>
                <div>
                  <div className="font-semibold">接口响应异常</div>
                  <div className="text-label mt-0.5">
                    {usersError}（若处于单人版或网关未就绪，此为正常静默降级状态）
                  </div>
                </div>
              </div>
            )}

            {usersLoading && !users ? (
              <div className="py-12 text-center text-label text-ink-faint">
                正在加载用户与容器状态…
              </div>
            ) : users && users.length === 0 ? (
              <div className="py-12 text-center text-label text-ink-faint">
                暂无注册用户数据
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-ui border-collapse">
                  <thead>
                    <tr className="border-b border-line text-label text-ink-muted bg-surface-muted/50">
                      <th className="py-2.5 px-3 font-medium">用户名 / 租户</th>
                      <th className="py-2.5 px-3 font-medium">角色</th>
                      <th className="py-2.5 px-3 font-medium">容器运行态</th>
                      <th className="py-2.5 px-3 font-medium">账号状态</th>
                      <th className="py-2.5 px-3 font-medium">注册时间</th>
                      <th className="py-2.5 px-3 font-medium text-right">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-faint">
                    {users?.map((u) => {
                      const busy = userActionBusy === u.name;
                      const cState = u.container?.state || "missing";
                      const healthy = u.container?.healthy;
                      const isHost = cState === "host";

                      return (
                        <tr
                          key={u.name}
                          className="hover:bg-surface-muted/30 transition-colors"
                        >
                          <td className="py-3 px-3">
                            <div className="font-medium text-ink-strong">
                              {u.name}
                            </div>
                            <div className="text-label font-mono text-ink-faint">
                              {u.tenant}
                            </div>
                          </td>

                          <td className="py-3 px-3">
                            <Pill tone={u.role === "admin" ? "accent" : "neutral"}>
                              {u.role === "admin" ? "管理员" : "普通用户"}
                            </Pill>
                          </td>

                          <td className="py-3 px-3">
                            <div className="flex items-center gap-1.5">
                              {cState === "running" && (
                                <Pill tone="positive">● 运行中</Pill>
                              )}
                              {cState === "stopped" && (
                                <Pill tone="neutral">已停止</Pill>
                              )}
                              {cState === "missing" && (
                                <Pill tone="danger">容器缺失</Pill>
                              )}
                              {cState === "host" && (
                                <Pill tone="warn">宿主实例</Pill>
                              )}

                              {healthy === true && (
                                <span
                                  className="text-positive text-nano font-medium"
                                  title="健康检查通过"
                                >
                                  ✓ 健康
                                </span>
                              )}
                              {healthy === false && (
                                <span
                                  className="text-danger text-nano font-medium"
                                  title="健康检查未通过"
                                >
                                  ✕ 异常
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-3 px-3">
                            {u.disabled ? (
                              <Pill tone="danger">已禁用</Pill>
                            ) : (
                              <Pill tone="positive">正常</Pill>
                            )}
                          </td>

                          <td className="py-3 px-3 text-label text-ink-faint">
                            {formatDate(u.createdAt)}
                          </td>

                          <td className="py-3 px-3 text-right">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {/* 启用 / 禁用 */}
                              <Button
                                size="sm"
                                variant={u.disabled ? "secondary" : "ghost"}
                                className={
                                  u.disabled
                                    ? ""
                                    : "text-danger hover:bg-danger-muted"
                                }
                                onClick={() =>
                                  void handleToggleUserDisabled(u)
                                }
                                loading={busy}
                              >
                                {u.disabled ? "启用" : "禁用"}
                              </Button>

                              {/* 重启容器 (host 租户不显示 restart) */}
                              {!isHost && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => void handleRestartUser(u)}
                                  loading={busy}
                                >
                                  重启容器
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Tab 2: 邀请码区 */}
        {activeTab === "invites" && (
          <section className="rounded-card border border-line bg-surface shadow-raise p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-ui font-semibold text-ink-strong">
                  邀请码管理
                </h2>
                <p className="text-label text-ink-faint">
                  生成一次性注册邀请码，分发给新租户自助注册并自动开辟隔离容器
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={loadInvites}
                  disabled={invitesLoading}
                >
                  刷新
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleCreateInvite}
                  loading={inviteActionBusy === "create"}
                >
                  + 生成新邀请码
                </Button>
              </div>
            </div>

            {invitesError && (
              <div className="p-3 rounded border border-warn-line bg-warn-muted/50 text-warn-ink text-ui">
                ⚠️ {invitesError}
              </div>
            )}

            {invitesLoading && !invites ? (
              <div className="py-12 text-center text-label text-ink-faint">
                加载邀请码列表…
              </div>
            ) : invites && invites.length === 0 ? (
              <div className="py-12 text-center text-label text-ink-faint">
                暂无邀请码记录，点击上方「生成新邀请码」创建
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-ui border-collapse">
                  <thead>
                    <tr className="border-b border-line text-label text-ink-muted bg-surface-muted/50">
                      <th className="py-2.5 px-3 font-medium">邀请码</th>
                      <th className="py-2.5 px-3 font-medium">状态</th>
                      <th className="py-2.5 px-3 font-medium">使用租户</th>
                      <th className="py-2.5 px-3 font-medium">创建时间</th>
                      <th className="py-2.5 px-3 font-medium text-right">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-faint">
                    {invites?.map((inv) => {
                      const busy = inviteActionBusy === inv.code;
                      const isUsed = Boolean(inv.usedBy);

                      return (
                        <tr
                          key={inv.code}
                          className="hover:bg-surface-muted/30 transition-colors"
                        >
                          <td className="py-3 px-3 font-mono font-medium text-ink-strong">
                            {inv.code}
                          </td>

                          <td className="py-3 px-3">
                            {isUsed ? (
                              <Pill tone="neutral">已使用</Pill>
                            ) : (
                              <Pill tone="positive">有效 / 未用</Pill>
                            )}
                          </td>

                          <td className="py-3 px-3 text-label">
                            {inv.usedBy ? (
                              <span className="font-mono text-ink-strong">
                                {inv.usedBy}
                              </span>
                            ) : (
                              <span className="text-ink-faint">-</span>
                            )}
                          </td>

                          <td className="py-3 px-3 text-label text-ink-faint">
                            {formatDate(inv.createdAt)}
                          </td>

                          <td className="py-3 px-3 text-right">
                            {!isUsed ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger hover:bg-danger-muted"
                                onClick={() => void handleDeleteInvite(inv.code)}
                                loading={busy}
                              >
                                作废
                              </Button>
                            ) : (
                              <span className="text-label text-ink-faint px-2">
                                -
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Tab 3: 共享池总览 (只读) */}
        {activeTab === "shares" && (
          <section className="rounded-card border border-line bg-surface shadow-raise p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-ui font-semibold text-ink-strong">
                  共享池凭证总览 (只读)
                </h2>
                <p className="text-label text-ink-faint">
                  查看各租户发布的 Claude Token 及大模型端点共享情况
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={loadShares}
                disabled={sharesLoading}
              >
                刷新
              </Button>
            </div>

            {sharesError && (
              <div className="p-3 rounded border border-warn-line bg-warn-muted/50 text-warn-ink text-ui">
                ⚠️ {sharesError}
              </div>
            )}

            {sharesLoading && !shares ? (
              <div className="py-12 text-center text-label text-ink-faint">
                加载共享池总览…
              </div>
            ) : shares && shares.length === 0 ? (
              <div className="py-12 text-center text-label text-ink-faint">
                共享池中暂无条目
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-ui border-collapse">
                  <thead>
                    <tr className="border-b border-line text-label text-ink-muted bg-surface-muted/50">
                      <th className="py-2.5 px-3 font-medium">名称 / 说明</th>
                      <th className="py-2.5 px-3 font-medium">类型</th>
                      <th className="py-2.5 px-3 font-medium">发布者</th>
                      <th className="py-2.5 px-3 font-medium">可见范围</th>
                      <th className="py-2.5 px-3 font-medium">已订阅数</th>
                      <th className="py-2.5 px-3 font-medium">创建时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-faint">
                    {shares?.map((s) => (
                      <tr
                        key={s.id}
                        className="hover:bg-surface-muted/30 transition-colors"
                      >
                        <td className="py-3 px-3 font-medium text-ink-strong">
                          {s.label}
                        </td>
                        <td className="py-3 px-3">
                          <Pill
                            tone={
                              s.type === "claude-token" ? "accent" : "neutral"
                            }
                          >
                            {s.type === "claude-token"
                              ? "Claude Token"
                              : "API 端点"}
                          </Pill>
                        </td>
                        <td className="py-3 px-3 text-label font-mono text-ink">
                          {s.owner}
                        </td>
                        <td className="py-3 px-3 text-label text-ink-muted">
                          {s.visibility === "all"
                            ? "全员可见"
                            : Array.isArray(s.visibility)
                              ? `指定租户 (${s.visibility.length} 人)`
                              : "指定"}
                        </td>
                        <td className="py-3 px-3 text-label tabular-nums">
                          <span className="font-semibold text-ink-strong">
                            {s.subscriberCount}
                          </span>{" "}
                          人
                        </td>
                        <td className="py-3 px-3 text-label text-ink-faint">
                          {formatDate(s.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>

      {/* 邀请码生成结果 Modal */}
      {createdInvite && (
        <Modal
          onClose={() => setCreatedInvite(null)}
          size="md"
          panelClassName="p-5"
        >
          <div className="flex items-center justify-between pb-3 border-b border-line">
            <h3 className="text-base font-semibold text-ink-strong flex items-center gap-2">
              <span>🎉</span>
              <span>邀请码生成成功</span>
            </h3>
            <button
              type="button"
              onClick={() => setCreatedInvite(null)}
              className="text-ink-muted hover:text-ink text-sm"
            >
              ✕
            </button>
          </div>

          <div className="py-4 space-y-3">
            <div>
              <label className="text-label text-ink-muted block mb-1">
                邀请码 (Code)
              </label>
              <div className="px-3 py-2 rounded-field bg-surface-muted border border-line font-mono text-base font-semibold text-ink-strong select-all">
                {createdInvite.code}
              </div>
            </div>

            <div>
              <label className="text-label text-ink-muted block mb-1">
                完整注册链接
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={createdInvite.url}
                  className="flex-1 px-3 py-2 rounded-field bg-surface-muted border border-line text-ui font-mono text-ink-muted select-all outline-none"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCopyUrl(createdInvite.url)}
                >
                  {copied ? "✓ 已复制" : "复制链接"}
                </Button>
              </div>
            </div>

            <div className="text-nano text-ink-faint">
              此链接为一次性注册入口，受邀者输入用户名与密码后将自动创建隔离工作空间。
            </div>
          </div>

          <div className="flex justify-end pt-2 border-t border-line">
            <Button variant="secondary" onClick={() => setCreatedInvite(null)}>
              完成
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
