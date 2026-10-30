"use client";
import { useEffect, useState } from "react";
import { ChevronRight, Plus, UserRound, Users } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { useRoleStore } from "@/stores/roleStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  PixelLoader,
  StatusDot,
  cn,
} from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { isButlerSession } from "@/lib/butler";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import type { Role } from "@/lib/roles";
import { useGroupStore } from "@/stores/groupStore";
import { GroupAvatar } from "@/components/GroupAvatar";
import type { Group } from "@/lib/groups";

// 侧栏「角色」分区（原型 docs/ui-redesign/mockups/09-roles.html 的 .sb-sec + .row.role）：
// 排在导航和「会话」之间；角色是常驻对象，不该被几百个会话淹没。
//   - 顺序沿用 GET /api/roles（最近活动降序，没聊过的按 sortOrder），最多露 5 行，其余收进「全部 N」；
//   - 行尾一个槽：固定会话在跑 = 像素格、完成未读 = 点、否则相对时间；
//   - 群聊（docs/roles-p2.md B）和角色混排：按最近活动排，四宫格头像，状态槽同角色行；
//   - ＋ 是个小菜单：新建角色 / 新建群聊；
//   - 末尾一行「管家」：管家暂不迁成角色（docs/roles-p1.md），点了走原来的 openButler。
// 桌面常驻栏与手机抽屉共用，mobile 只换行高（44px 触控）与按压反馈。

const VISIBLE = 5;

/** 管家行的头像：借 RoleAvatar 画同款圆，色相取原型里的 255。 */
const BUTLER_AVATAR = { avatarHue: 255, avatarGlyph: "管", name: "管家" };

/** 侧栏副标题只要一小截：介绍按标点截第一句，再限长。 */
function shortIntro(intro: string): string {
  const first = intro.trim().split(/[。，,.；;！!？?\n]/)[0] ?? "";
  return first.length > 8 ? `${first.slice(0, 8)}…` : first;
}

export function RoleSidebarSection({ mobile = false }: { mobile?: boolean }) {
  const roles = useRoleStore((s) => s.roles);
  const refresh = useRoleStore((s) => s.refresh);
  const sessionsRevision = useSessionStore((s) => s.sessionsRevision);
  const openRole = useSessionStore((s) => s.openRole);
  const openButler = useSessionStore((s) => s.openButler);
  const butlerActive = useSessionStore((s) => (s.butlerDraft ? !s.session : isButlerSession(s.session)));
  // 高亮：会话的 agentId 就是角色 id；还没会话时看角色草稿。
  const activeRoleId = useSessionStore((s) =>
    s.session ? (s.session.agentId ?? null) : s.homeOpen ? s.roleDraft : null,
  );
  const runningIds = useSessionStore((s) => s.runningSessionIds);
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);
  const activeSessionId = useSessionStore((s) => s.session?.id ?? null);
  // 正开着的会话不等 /api/runs 轮询，直接看本地节点（同 SessionSidebar.isRunning）。
  const activeStreaming = useSessionStore((s) => Object.values(s.nodes).some((n) => n.status === "streaming"));
  const [expanded, setExpanded] = useState(false);
  const groups = useGroupStore((s) => s.groups);
  const refreshGroups = useGroupStore((s) => s.refresh);
  const activeGroupId = useSessionStore((s) => (s.session?.kind === "group" ? s.session.id : null));
  const previewSession = useSessionStore((s) => s.previewSession);
  const setMobileNavOpen = useSessionStore((s) => s.setMobileNavOpen);

  // 挂载拉一次；会话列表变了（发完一轮、建出固定会话）再拉，lastActiveAt / homeSessionId 才跟得上。
  useEffect(() => {
    void refresh();
    void refreshGroups();
  }, [refresh, refreshGroups, sessionsRevision]);

  // 角色与群聊混排：有活动时间的按时间降序，没聊过的角色保持服务端顺序垫后。
  type Entry = { kind: "role"; role: Role; at: number | null } | { kind: "group"; group: Group; at: number };
  const entries: Entry[] = [
    ...roles.map((role): Entry => ({ kind: "role", role, at: role.lastActiveAt })),
    ...groups.map((group): Entry => ({ kind: "group", group, at: group.lastActiveAt })),
  ]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const x = a.e.at ?? -Infinity;
      const y = b.e.at ?? -Infinity;
      return x !== y ? y - x : a.i - b.i;
    })
    .map(({ e }) => e);
  const visible = expanded ? entries : entries.slice(0, VISIBLE);
  const hidden = entries.length - visible.length;
  // 相对时间的「现在」：每分钟走一格（同 HomeView），常驻侧栏不至于一直停在打开时的时刻。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const statusOf = (r: Pick<Role, "homeSessionId">): "running" | "unread" | null => {
    const sid = r.homeSessionId;
    if (!sid) return null;
    if (runningIds.has(sid) || (sid === activeSessionId && activeStreaming)) return "running";
    if (unreadIds.has(sid) && sid !== activeSessionId) return "unread";
    return null;
  };

  const rowClass = (active: boolean) =>
    cn(
      "flex w-full min-w-0 items-center gap-2 rounded-field px-2 text-left font-medium transition-colors duration-150",
      mobile ? "press-row h-11 text-ui" : "h-8 text-[13.5px]",
      active ? "bg-surface-hover text-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
    );

  return (
    <div data-sidebar-roles className={mobile ? "px-1.5 pb-1" : undefined}>
      <div data-sidebar-section="roles" className={cn("flex items-center gap-1 pl-2", mobile ? "h-9" : "mt-2.5 h-7.5")}>
        <span className="min-w-0 flex-1 truncate text-label font-medium text-ink-faint">角色</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="sm"
              label="新建角色或群聊"
              data-sidebar-new-role
              className={mobile ? "min-h-11 min-w-11" : undefined}
            >
              <Icon icon={Plus} size="sm" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-sidebar-new-role-item
              icon={<UserRound size={16} />}
              onSelect={() => useRoleStore.getState().setNewRoleOpen(true)}
            >
              新建角色
            </DropdownMenuItem>
            <DropdownMenuItem
              data-sidebar-new-group
              icon={<Users size={16} />}
              onSelect={() => useGroupStore.getState().setNewGroupOpen(true)}
            >
              新建群聊
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-px">
        {visible.map((entry) => {
          if (entry.kind === "group") {
            const g = entry.group;
            const active = activeGroupId === g.id;
            const status = statusOf({ homeSessionId: g.id });
            return (
              <button
                key={`g:${g.id}`}
                type="button"
                data-glide-row
                data-sidebar-group={g.id}
                aria-current={active ? "page" : undefined}
                title={`${g.name} · ${g.members.map((m) => m.name).join("、")}`}
                onClick={() => {
                  void previewSession(g.id);
                  setMobileNavOpen(false);
                }}
                className={rowClass(active)}
              >
                <GroupAvatar members={g.members} size={mobile ? "sm" : "xs"} />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
                  <span className="truncate">{g.name}</span>
                  <span className="shrink-0 truncate text-nano font-normal text-ink-faint">{g.members.length} 位</span>
                </span>
                {status === "running" ? (
                  <PixelLoader size="sm" label="讨论中" />
                ) : status === "unread" ? (
                  <StatusDot tone="unread" label="有新消息" />
                ) : (
                  <span className="shrink-0 text-nano font-normal tabular-nums text-ink-faint">
                    {formatRelativeTimeShort(g.lastActiveAt, now)}
                  </span>
                )}
              </button>
            );
          }
          const r = entry.role;
          const active = activeRoleId === r.id;
          const status = statusOf(r);
          const sub = shortIntro(r.intro);
          return (
            <button
              key={r.id}
              type="button"
              data-glide-row
              data-sidebar-role={r.id}
              aria-current={active ? "page" : undefined}
              title={r.intro ? `${r.name} · ${r.intro}` : r.name}
              onClick={() => void openRole(r.id)}
              className={rowClass(active)}
            >
              <RoleAvatar role={r} size={mobile ? "sm" : "xs"} />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
                <span className="truncate">{r.name}</span>
                {sub && <span className="shrink-0 truncate text-nano font-normal text-ink-faint">{sub}</span>}
              </span>
              {status === "running" ? (
                <PixelLoader size="sm" label="生成中" />
              ) : status === "unread" ? (
                <StatusDot tone="unread" label="完成·未读" />
              ) : r.lastActiveAt ? (
                <span className="shrink-0 text-nano font-normal tabular-nums text-ink-faint">
                  {formatRelativeTimeShort(r.lastActiveAt, now)}
                </span>
              ) : null}
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            data-glide-row
            data-sidebar-roles-more
            onClick={() => setExpanded(true)}
            className={cn(rowClass(false), "text-ink-faint")}
          >
            <span className="grid size-5 shrink-0 place-items-center">
              <Icon icon={ChevronRight} size="sm" />
            </span>
            <span className="min-w-0 flex-1 truncate">全部 {entries.length}</span>
          </button>
        )}
        <button
          type="button"
          data-glide-row
          data-sidebar-butler
          data-mobile-target="drawer-butler"
          aria-current={butlerActive ? "page" : undefined}
          title="管家：用对话配置 Trellis"
          onClick={() => void openButler()}
          className={rowClass(butlerActive)}
        >
          <RoleAvatar role={BUTLER_AVATAR} size={mobile ? "sm" : "xs"} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
            <span className="truncate">管家</span>
            <span className="shrink-0 truncate text-nano font-normal text-ink-faint">配置 Trellis</span>
          </span>
        </button>
      </div>
    </div>
  );
}
