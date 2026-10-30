"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, ContactRound, Plus, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  PageHeader,
  RoleAvatar,
  Skeleton,
  Spinner,
} from "@/components/ui";
import { formatRelativeTime } from "@/lib/relative-time";
import { useRoleStore } from "@/stores/roleStore";

// 角色列表（docs/roles-p1.md「设置」）。和 Agent 页不同，这里只列不编辑：角色的编辑面
// 有四个 tab（资料 / 人设 / 记忆 / 高级），装不进右半栏，点一行进 /settings/roles/<id>。
// 新建走全局的 NewRoleModal（roleStore.newRoleOpen），和侧栏 ＋ 是同一个弹窗。

export default function RolesSettingsPage() {
  const { roles, loaded, error, refresh, setNewRoleOpen } = useRoleStore();
  const [refreshing, setRefreshing] = useState(false);

  // 每次进页都拉一次：记忆条数、最近活跃会随对话变，缓存可能是旧的
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reload = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const newButton = (
    <Button variant="primary" onClick={() => setNewRoleOpen(true)}>
      <Icon icon={Plus} />
      新建角色
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="角色"
        count={loaded ? roles.length : undefined}
        countUnit="个角色"
        subtitle={loaded ? `一共记得 ${roles.reduce((n, r) => n + r.memoryCount, 0)} 条` : undefined}
        actions={
          <>
            <IconButton
              label="刷新"
              className="md:bg-surface-raised md:shadow-btn"
              onClick={() => void reload()}
              disabled={refreshing}
            >
              {refreshing ? <Spinner label={null} /> : <Icon icon={RefreshCw} />}
            </IconButton>
            {newButton}
          </>
        }
      />

      {!loaded ? (
        <div
          role="status"
          aria-label="加载中"
          className="overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-1/4" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      ) : error && !roles.length ? (
        <ErrorCallout error={error} title="角色列表加载失败" onRetry={() => void reload()} />
      ) : !roles.length ? (
        <EmptyState
          icon={ContactRound}
          title="还没有角色"
          description="角色是有名字、有记忆的长期搭档：一条固定会话，越聊越了解你。"
          action={newButton}
          className="rounded-card bg-surface-raised shadow-raise ui-enter-up"
        />
      ) : (
        <ul className="ui-enter-up overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line">
          {roles.map((r) => (
            <li key={r.id}>
              <Link
                href={`/settings/roles/${encodeURIComponent(r.id)}`}
                className="flex min-h-15 items-center gap-3 px-4 py-2.5 transition-colors duration-100 hover:bg-surface-hover"
              >
                <RoleAvatar role={r} size="lg" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-ui font-medium text-ink-strong">{r.name}</span>
                    {r.builtin && <Badge>内置</Badge>}
                    {!r.memoryEnabled && <Badge>记忆已关</Badge>}
                  </span>
                  <span className="truncate text-label text-ink-muted">{r.intro || "还没写介绍"}</span>
                </span>
                <span className="hidden shrink-0 flex-col items-end gap-0.5 text-label text-ink-faint sm:flex">
                  <span>记得 {r.memoryCount} 条</span>
                  <span>{r.lastActiveAt ? `${formatRelativeTime(r.lastActiveAt)}聊过` : "还没聊过"}</span>
                </span>
                <Icon icon={ChevronRight} size="sm" className="shrink-0 text-ink-faint" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
