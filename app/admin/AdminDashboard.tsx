"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Copy,
  Plus,
  RefreshCw,
  Settings,
  Share2,
  ShieldCheck,
  Ticket,
  Unplug,
  Users,
  X,
} from "lucide-react";
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
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useConfirm,
} from "@/components/ui";
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

/** /__gw/api/* 只由多租户网关（tenancy/gateway）提供，Next 本身没有这些路由。
 * 直连宿主（不经网关，例如 3088 或 dev）时请求落到 Next → 404：这是「单人版不提供」，
 * 不是故障。原来这里渲染成黄色「接口响应异常 请求失败 (HTTP 404)」。 */
function isGatewayAbsent(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

type Tab = "users" | "invites" | "shares";

export function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("users");
  const confirm = useConfirm();

  // 用户表状态
  const [users, setUsers] = useState<GwAdminUser[] | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<unknown>(null);
  const [userActionBusy, setUserActionBusy] = useState<string | null>(null);

  // 邀请码状态
  const [invites, setInvites] = useState<GwInvite[] | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState<unknown>(null);
  const [inviteActionBusy, setInviteActionBusy] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] =
    useState<GwInviteCreateResponse | null>(null);

  // 共享池状态
  const [shares, setShares] = useState<GwShare[] | null>(null);
  const [sharesLoading, setSharesLoading] = useState(true);
  const [sharesError, setSharesError] = useState<unknown>(null);

  // 保持 .then 链：setState 待在回调里，满足 eslint react-hooks/set-state-in-effect
  const loadUsers = useCallback((): Promise<void> => {
    return fetchAdminUsers()
      .then((data) => {
        setUsers(data);
        setUsersError(null);
        setUsersLoading(false);
      })
      .catch((err: unknown) => {
        setUsersError(err ?? new Error("无法加载用户列表"));
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
      .catch((err: unknown) => {
        setInvitesError(err ?? new Error("无法加载邀请码列表"));
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
      .catch((err: unknown) => {
        setSharesError(err ?? new Error("无法加载共享池列表"));
        setSharesLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadUsers();
    void loadInvites();
    void loadShares();
  }, [loadUsers, loadInvites, loadShares]);

  const [refreshing, setRefreshing] = useState(false);
  const refreshActive = () => {
    setRefreshing(true);
    const p =
      activeTab === "users" ? loadUsers() : activeTab === "invites" ? loadInvites() : loadShares();
    void p.finally(() => setRefreshing(false));
  };

  const handleToggleUserDisabled = async (user: GwAdminUser) => {
    const action = user.disabled ? "启用" : "禁用";
    const ok = await confirm({
      title: `${action}用户「${user.name}」？`,
      description: user.disabled
        ? "启用后对方可以重新登录使用。"
        : "禁用后对方的登录会话立即失效，直到重新启用。",
      confirmLabel: action,
      danger: !user.disabled,
    });
    if (!ok) return;

    setUserActionBusy(user.name);
    try {
      if (user.disabled) {
        await enableAdminUser(user.name);
        toast.success(`已启用用户「${user.name}」`);
      } else {
        await disableAdminUser(user.name);
        toast.success(`已禁用用户「${user.name}」`);
      }
      await loadUsers();
    } catch (err) {
      toast.error(`${action}失败`, { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setUserActionBusy(null);
    }
  };

  const handleRestartUser = async (user: GwAdminUser) => {
    if (user.container.state === "host") return;
    const ok = await confirm({
      title: `重启「${user.name}」的租户容器？`,
      description: "重启过程中对方的连接会短暂中断，正在生成的会话会被打断。",
      confirmLabel: "重启容器",
      danger: true,
    });
    if (!ok) return;

    setUserActionBusy(user.name);
    try {
      await restartAdminUser(user.name);
      toast.success("已发送重启指令", { description: `「${user.name}」的容器正在重启。` });
      await loadUsers();
    } catch (err) {
      toast.error("重启容器失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setUserActionBusy(null);
    }
  };

  const handleCreateInvite = async () => {
    setInviteActionBusy("create");
    try {
      const res = await createAdminInvite();
      setCreatedInvite(res);
      await loadInvites();
    } catch (err) {
      toast.error("生成邀请码失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setInviteActionBusy(null);
    }
  };

  const handleDeleteInvite = async (code: string) => {
    const ok = await confirm({
      title: `作废邀请码「${code}」？`,
      description: "作废后这个邀请链接不能再用于注册；已经用它注册的账号不受影响。",
      confirmLabel: "作废",
      danger: true,
    });
    if (!ok) return;

    setInviteActionBusy(code);
    try {
      await deleteAdminInvite(code);
      toast.success("邀请码已作废");
      await loadInvites();
    } catch (err) {
      toast.error("作废邀请码失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setInviteActionBusy(null);
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("已复制注册链接");
    } catch {
      toast.error("复制失败", { description: "浏览器拒绝了剪贴板访问，请手动选中链接复制。" });
    }
  };

  // 三个接口都落到 404 = 直连单人版：整页给一个说明态，不再逐 tab 报错。
  const allAbsent =
    !usersLoading &&
    !invitesLoading &&
    !sharesLoading &&
    isGatewayAbsent(usersError) &&
    isGatewayAbsent(invitesError) &&
    isGatewayAbsent(sharesError);

  const tableSkeleton = (
    <div role="status" aria-label="加载中" className="flex flex-col gap-2.5 py-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );

  const errorBlock = (err: unknown, what: string, retry: () => void) =>
    isGatewayAbsent(err) ? (
      <EmptyState
        compact
        icon={Unplug}
        title="单人版不提供此功能"
        description={`${what}由多租户网关提供；当前是直连访问，没有经过网关。`}
      />
    ) : (
      <ErrorCallout
        error={err}
        title={`${what}加载失败`}
        hint="确认多租户网关在运行、且是经网关地址访问的，然后重试。"
        onRetry={retry}
      />
    );

  const th = "py-2.5 px-3 font-medium";
  const td = "py-3 px-3";

  return (
    <div className="h-dvh overflow-y-auto bg-surface-canvas text-ink">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-surface-canvas px-4 md:px-5">
        <Link
          href="/"
          className="-ml-1.5 inline-flex items-center gap-1.5 rounded-field px-1.5 h-8 text-ui text-ink-muted transition-colors duration-100 hover:bg-surface-hover hover:text-ink max-md:min-h-11"
        >
          <Icon icon={ArrowLeft} />
          返回工作台
        </Link>
        <span aria-hidden className="h-4.5 w-px bg-line" />
        <span className="text-ui font-semibold text-ink-strong">管理控制台</span>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link href="/settings">
            <Icon icon={Settings} size="sm" />
            设置
          </Link>
        </Button>
      </header>

      <main className="mx-auto flex max-w-[1000px] flex-col gap-5 p-4 pb-24 md:px-8 md:pt-7">
        <PageHeader
          title={
            <span className="inline-flex items-center gap-2">
              Trellis 管理控制台
              <Badge variant="accent">
                <Icon icon={ShieldCheck} size="sm" />
                仅管理员
              </Badge>
            </span>
          }
          subtitle="多租户网关的用户、邀请码与共享池"
          actions={
            allAbsent ? undefined : (
              <>
                <IconButton label="刷新当前页" onClick={refreshActive} disabled={refreshing}>
                  <Icon icon={RefreshCw} className={refreshing ? "animate-spin" : undefined} />
                </IconButton>
                {activeTab === "invites" && (
                  <Button
                    variant="primary"
                    onClick={() => void handleCreateInvite()}
                    loading={inviteActionBusy === "create"}
                    disabled={invitesError !== null}
                  >
                    <Icon icon={Plus} />
                    生成邀请码
                  </Button>
                )}
              </>
            )
          }
        />

        {allAbsent ? (
          <EmptyState
            icon={Unplug}
            title="单人版不提供管理控制台"
            description="用户、邀请码与共享池都由多租户网关提供。当前是直连访问的单人版（请求没有经过网关），所以这里没有可管理的内容。"
            action={
              <Button asChild>
                <Link href="/settings">去设置</Link>
              </Button>
            }
            className="rounded-card border border-line"
          />
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="users">
                <Icon icon={Users} size="sm" />
                用户与容器
                {users && <span className="tabular-nums text-ink-faint">{users.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="invites">
                <Icon icon={Ticket} size="sm" />
                邀请码
                {invites && <span className="tabular-nums text-ink-faint">{invites.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="shares">
                <Icon icon={Share2} size="sm" />
                共享池总览
                {shares && <span className="tabular-nums text-ink-faint">{shares.length}</span>}
              </TabsTrigger>
            </TabsList>

            {/* Tab 1: 用户表 */}
            <TabsContent value="users" className="pt-4 flex flex-col gap-3">
              <p className="text-label text-ink-muted">
                全部注册用户、角色、隔离容器的运行状态与健康检查
              </p>
              {usersError !== null ? (
                errorBlock(usersError, "用户列表", () => void loadUsers())
              ) : usersLoading && !users ? (
                tableSkeleton
              ) : users && users.length === 0 ? (
                <EmptyState compact icon={Users} title="还没有注册用户" description="发出邀请码后，新用户注册会出现在这里。" />
              ) : (
                <div className="overflow-x-auto rounded-card border border-line bg-surface">
                  <table className="w-full text-left text-ui border-collapse">
                    <thead>
                      <tr className="border-b border-line text-label text-ink-muted">
                        <th className={th}>用户 / 租户</th>
                        <th className={th}>角色</th>
                        <th className={th}>容器</th>
                        <th className={th}>账号</th>
                        <th className={th}>注册时间</th>
                        <th className={`${th} text-right`}>操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-faint">
                      {users?.map((u) => {
                        const busy = userActionBusy === u.name;
                        const cState = u.container?.state || "missing";
                        const healthy = u.container?.healthy;
                        const isHost = cState === "host";

                        return (
                          <tr key={u.name} className="hover:bg-surface-hover transition-colors duration-100">
                            <td className={td}>
                              <div className="font-medium text-ink-strong">{u.name}</div>
                              <div className="text-label font-mono text-ink-faint">{u.tenant}</div>
                            </td>
                            <td className={td}>
                              <Badge variant={u.role === "admin" ? "accent" : "neutral"}>
                                {u.role === "admin" ? "管理员" : "普通用户"}
                              </Badge>
                            </td>
                            <td className={td}>
                              <div className="flex items-center gap-1.5">
                                {cState === "running" && <Badge variant="positive" dot>运行中</Badge>}
                                {cState === "stopped" && <Badge>已停止</Badge>}
                                {cState === "missing" && <Badge variant="danger">容器缺失</Badge>}
                                {cState === "host" && <Badge variant="warn">宿主实例</Badge>}
                                {healthy === true && (
                                  <span className="inline-flex items-center gap-0.5 text-label text-positive-ink">
                                    <Icon icon={Check} size="sm" />
                                    健康
                                  </span>
                                )}
                                {healthy === false && (
                                  <span className="inline-flex items-center gap-0.5 text-label text-danger-ink">
                                    <Icon icon={X} size="sm" />
                                    异常
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className={td}>
                              {u.disabled ? <Badge variant="danger">已禁用</Badge> : <Badge variant="positive">正常</Badge>}
                            </td>
                            <td className={`${td} text-label text-ink-muted tabular-nums`}>{formatDate(u.createdAt)}</td>
                            <td className={`${td} text-right`}>
                              <div className="inline-flex items-center justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant={u.disabled ? "secondary" : "danger"}
                                  onClick={() => void handleToggleUserDisabled(u)}
                                  loading={busy}
                                >
                                  {u.disabled ? "启用" : "禁用"}
                                </Button>
                                {/* 重启容器 (host 租户不显示 restart) */}
                                {!isHost && (
                                  <Button size="sm" onClick={() => void handleRestartUser(u)} disabled={busy}>
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
            </TabsContent>

            {/* Tab 2: 邀请码区 */}
            <TabsContent value="invites" className="pt-4 flex flex-col gap-3">
              <p className="text-label text-ink-muted">
                生成一次性注册邀请码，发给新用户自助注册并自动开一个隔离容器
              </p>
              {invitesError !== null ? (
                errorBlock(invitesError, "邀请码", () => void loadInvites())
              ) : invitesLoading && !invites ? (
                tableSkeleton
              ) : invites && invites.length === 0 ? (
                <EmptyState
                  compact
                  icon={Ticket}
                  title="还没有邀请码"
                  description="生成一个邀请码，把注册链接发给新用户。"
                  action={
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void handleCreateInvite()}
                      loading={inviteActionBusy === "create"}
                    >
                      <Icon icon={Plus} size="sm" />
                      生成邀请码
                    </Button>
                  }
                />
              ) : (
                <div className="overflow-x-auto rounded-card border border-line bg-surface">
                  <table className="w-full text-left text-ui border-collapse">
                    <thead>
                      <tr className="border-b border-line text-label text-ink-muted">
                        <th className={th}>邀请码</th>
                        <th className={th}>状态</th>
                        <th className={th}>使用者</th>
                        <th className={th}>创建时间</th>
                        <th className={`${th} text-right`}>操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-faint">
                      {invites?.map((inv) => {
                        const busy = inviteActionBusy === inv.code;
                        const isUsed = Boolean(inv.usedBy);
                        return (
                          <tr key={inv.code} className="hover:bg-surface-hover transition-colors duration-100">
                            <td className={`${td} font-mono font-medium text-ink-strong`}>{inv.code}</td>
                            <td className={td}>
                              {isUsed ? <Badge>已使用</Badge> : <Badge variant="positive">有效</Badge>}
                            </td>
                            <td className={`${td} text-label`}>
                              {inv.usedBy ? (
                                <span className="font-mono text-ink-strong">{inv.usedBy}</span>
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                            <td className={`${td} text-label text-ink-muted tabular-nums`}>{formatDate(inv.createdAt)}</td>
                            <td className={`${td} text-right`}>
                              {!isUsed ? (
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => void handleDeleteInvite(inv.code)}
                                  loading={busy}
                                >
                                  作废
                                </Button>
                              ) : (
                                <span className="text-label text-ink-faint px-2">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            {/* Tab 3: 共享池总览 (只读) */}
            <TabsContent value="shares" className="pt-4 flex flex-col gap-3">
              <p className="text-label text-ink-muted">
                各用户发布的 Claude Token 与大模型端点（只读）
              </p>
              {sharesError !== null ? (
                errorBlock(sharesError, "共享池", () => void loadShares())
              ) : sharesLoading && !shares ? (
                tableSkeleton
              ) : shares && shares.length === 0 ? (
                <EmptyState compact icon={Share2} title="共享池里还没有条目" description="用户在「设置 → 共享池」发布后会出现在这里。" />
              ) : (
                <div className="overflow-x-auto rounded-card border border-line bg-surface">
                  <table className="w-full text-left text-ui border-collapse">
                    <thead>
                      <tr className="border-b border-line text-label text-ink-muted">
                        <th className={th}>名称 / 说明</th>
                        <th className={th}>类型</th>
                        <th className={th}>发布者</th>
                        <th className={th}>可见范围</th>
                        <th className={th}>订阅</th>
                        <th className={th}>创建时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-faint">
                      {shares?.map((s) => (
                        <tr key={s.id} className="hover:bg-surface-hover transition-colors duration-100">
                          <td className={`${td} font-medium text-ink-strong`}>{s.label}</td>
                          <td className={td}>
                            <Badge variant={s.type === "claude-token" ? "accent" : "neutral"}>
                              {s.type === "claude-token" ? "Claude Token" : "API 端点"}
                            </Badge>
                          </td>
                          <td className={`${td} text-label font-mono text-ink`}>{s.owner}</td>
                          <td className={`${td} text-label text-ink-muted`}>
                            {s.visibility === "all"
                              ? "全员可见"
                              : Array.isArray(s.visibility)
                                ? `指定 ${s.visibility.length} 人`
                                : "指定"}
                          </td>
                          <td className={`${td} text-label tabular-nums text-ink`}>{s.subscriberCount} 人</td>
                          <td className={`${td} text-label text-ink-muted tabular-nums`}>{formatDate(s.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </main>

      {/* 邀请码生成结果 Modal */}
      {createdInvite && (
        <Modal onClose={() => setCreatedInvite(null)} size="md" title="邀请码已生成" panelClassName="p-5">
          <div className="flex items-center justify-between pb-3 border-b border-line">
            <h3 className="text-body font-semibold text-ink-strong flex items-center gap-2">
              <Icon icon={Ticket} className="text-ink-muted" />
              邀请码已生成
            </h3>
            <IconButton label="关闭" size="sm" onClick={() => setCreatedInvite(null)}>
              <Icon icon={X} size="sm" />
            </IconButton>
          </div>

          <div className="py-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-label text-ink-muted">邀请码</span>
              <div className="px-3 py-2 rounded-field bg-surface-muted border border-line font-mono text-body font-semibold text-ink-strong select-all">
                {createdInvite.code}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-label text-ink-muted">完整注册链接</span>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="完整注册链接"
                  value={createdInvite.url}
                  className="font-mono text-ink-muted"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="primary" onClick={() => void handleCopyUrl(createdInvite.url)}>
                  <Icon icon={Copy} />
                  复制链接
                </Button>
              </div>
            </div>

            <div className="text-label text-ink-faint">
              这是一次性注册入口：受邀者填用户名和密码后，会自动创建一个隔离的工作空间。
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-line">
            <Button onClick={() => setCreatedInvite(null)}>完成</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
