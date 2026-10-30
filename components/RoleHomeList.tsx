"use client";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { useRoleStore } from "@/stores/roleStore";
import { Icon, IconButton, PixelLoader, StatusDot } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { formatRelativeTimeShort } from "@/lib/relative-time";

// 手机首页顶部的「角色」块（原型 09-roles.html s-mlist）：大头像 + 名字 + 时间 + 一行副标题，
// 像聊天 App 的会话列表。副标题 P1 先用一句话介绍（接口还不带最后一句话）。
// 末尾同样放「管家」。角色列表由侧栏 / 抽屉的 RoleSidebarSection 负责 refresh，这里只读。

const BUTLER_AVATAR = { avatarHue: 255, avatarGlyph: "管", name: "管家" };

export function RoleHomeList() {
  const roles = useRoleStore((s) => s.roles);
  const loaded = useRoleStore((s) => s.loaded);
  const openRole = useSessionStore((s) => s.openRole);
  const openButler = useSessionStore((s) => s.openButler);
  const runningIds = useSessionStore((s) => s.runningSessionIds);
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // 首页可能先于抽屉挂载（抽屉关着时不渲染列表），自己兜底拉一次。
  useEffect(() => {
    if (!loaded) void useRoleStore.getState().refresh();
  }, [loaded]);

  const row =
    "press-row flex min-h-15 w-full min-w-0 items-center gap-3 rounded-[14px] px-1.5 py-2.5 text-left";

  return (
    <section data-home-section="roles" aria-labelledby="home-roles" className="mb-5">
      <div className="mb-1 flex items-center justify-between px-1">
        <h2 id="home-roles" className="text-title font-semibold tracking-[-0.02em] text-ink-strong">
          角色
        </h2>
        <IconButton
          label="新建角色"
          onClick={() => useRoleStore.getState().setNewRoleOpen(true)}
          className="min-h-11 min-w-11"
          tooltip={false}
        >
          <Icon icon={Plus} />
        </IconButton>
      </div>
      <div className="flex flex-col">
        {roles.map((r) => {
          const sid = r.homeSessionId;
          const running = sid ? runningIds.has(sid) : false;
          const unread = sid ? unreadIds.has(sid) : false;
          return (
            <button key={r.id} type="button" data-home-role={r.id} onClick={() => void openRole(r.id)} className={row}>
              <RoleAvatar role={r} size="lg" status={running ? "busy" : undefined} />
              <span className="min-w-0 flex-1 border-b border-line pb-2.5 -mb-2.5">
                <span className="flex items-center gap-1.5 text-reading font-semibold text-ink-strong">
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="ml-auto shrink-0 text-label font-normal tabular-nums text-ink-faint">
                    {r.lastActiveAt ? formatRelativeTimeShort(r.lastActiveAt, now) : ""}
                  </span>
                </span>
                <span className="mt-px flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-ui text-ink-muted">
                    {running ? "正在回复…" : r.intro || "还没聊过"}
                  </span>
                  {running ? <PixelLoader size="sm" label={null} /> : unread && <StatusDot tone="unread" label="有新回复" />}
                </span>
              </span>
            </button>
          );
        })}
        <button type="button" data-home-role="butler" onClick={() => void openButler()} className={row}>
          <RoleAvatar role={BUTLER_AVATAR} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-reading font-semibold text-ink-strong">管家</span>
            <span className="mt-px block truncate text-ui text-ink-muted">用对话配置 Trellis</span>
          </span>
        </button>
      </div>
    </section>
  );
}
