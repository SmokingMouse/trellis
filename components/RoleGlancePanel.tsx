"use client";
import { useEffect, useState } from "react";
import { Brain, FolderOpen, ListChecks, UserRound } from "lucide-react";
import { RoleFollowToggle } from "@/components/RoleFollowToggle";
import { useRoleStore } from "@/stores/roleStore";
import { Icon, Pill, Skeleton } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { MEMORY_TYPE_LABEL, type MemoryType, type Role } from "@/lib/roles";
import { RoleGlanceBlocks } from "./RoleGlanceBlocks";

// 角色一览（原型 09-roles.html 的 .glance，对应 Cindy 的 At a glance）：不离开对话就能看清
// 「它是谁、记得什么、在哪干活」。P1：人设 / 最近记忆 / 目录 / 模型；P2：例行 / 渠道 / 后台任务
// （RoleGlanceBlocks，排在最近记忆之后，同原型顺序）。
// 桌面右栏照 ButlerPanel 的 --trellis-rp 机制占位（≥1280px 才出，300px）；手机顶栏点头像出
// 同一份内容的底部 sheet（RoleGlanceContent）。记忆列表由 LinearThreadView 的 useRoleMemorySync 保鲜。

const PANEL_W = "300px";
const WIDE_QUERY = "(min-width: 1280px)";
const PERSONA_PREVIEW = 120;

const TYPE_TONE: Record<MemoryType, "accent" | "fork" | "positive" | "neutral"> = {
  user: "accent",
  feedback: "fork",
  project: "positive",
  reference: "neutral",
};

export function roleSettingsHref(roleId: string, tab?: string): string {
  return `/settings/roles/${encodeURIComponent(roleId)}${tab ? `?tab=${tab}` : ""}`;
}

/** 一览正文：桌面右栏与手机 sheet 共用。 */
export function RoleGlanceContent({ role }: { role: Role }) {
  const list = useRoleStore((s) => s.memories[role.id]);
  const recent = list
    ? [...list.memories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
    : null;
  const persona = role.systemPrompt.trim();
  const dir = role.workDir ?? role.homeDir;

  return (
    <div data-role-glance={role.id} className="flex flex-col">
      <div className="flex flex-col items-center gap-1.5 px-2 pt-2 pb-5 text-center">
        <RoleAvatar role={role} size="xl" className="mb-1.5" />
        <span className="text-[15px] font-semibold text-ink-strong">{role.name}</span>
        {role.intro && <span className="text-label leading-relaxed text-ink-muted">{role.intro}</span>}
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {role.model && <Pill className="font-mono">{role.model}</Pill>}
          <Pill tone={role.memoryEnabled ? "fork" : "neutral"}>{role.memoryEnabled ? "记忆开" : "记忆关"}</Pill>
        </div>
      </div>

      <Section
        icon={Brain}
        title="最近记住的"
        action={
          <a href={roleSettingsHref(role.id, "memory")} className="text-label text-ink-faint hover:text-ink">
            全部 {list?.memories.length ?? role.memoryCount}
          </a>
        }
      >
        {!recent ? (
          <div className="px-3 py-2.5">
            <Skeleton className="h-3 w-full" />
          </div>
        ) : recent.length === 0 ? (
          <div className="px-3 py-2.5 text-label text-ink-faint">
            {role.memoryEnabled ? "还没记下什么。聊到要紧的事它会自己记，也可以 /remember" : "记忆已关"}
          </div>
        ) : (
          recent.map((m) => (
            <a
              key={m.file}
              href={roleSettingsHref(role.id, "memory")}
              title={m.description || m.name}
              className="flex items-start gap-2 px-3 py-2 text-ui text-ink transition-colors duration-100 hover:bg-surface-hover [&+&]:border-t [&+&]:border-line"
            >
              <Pill tone={TYPE_TONE[m.type] ?? "neutral"} className="mt-px shrink-0">
                {MEMORY_TYPE_LABEL[m.type] ?? m.type}
              </Pill>
              <span className="line-clamp-2 min-w-0 flex-1 leading-snug">{m.name}</span>
            </a>
          ))
        )}
      </Section>

      <RoleGlanceBlocks role={role} Section={Section} settingsHref={(tab) => roleSettingsHref(role.id, tab)} />

      <Section icon={FolderOpen} title="默认目录">
        <div className="px-3 py-2.5">
          <div className="break-all font-mono text-label text-ink" title={dir}>
            {dir}
          </div>
          {!role.workDir && <div className="mt-0.5 text-nano text-ink-faint">没设工作目录，就在角色目录里干活</div>}
        </div>
      </Section>

      <Section
        icon={UserRound}
        title="人设"
        action={
          <a href={roleSettingsHref(role.id, "persona")} className="text-label text-ink-faint hover:text-ink">
            编辑
          </a>
        }
      >
        <p className="px-3 py-2.5 text-label leading-relaxed whitespace-pre-line text-ink-muted">
          {persona
            ? persona.length > PERSONA_PREVIEW
              ? `${persona.slice(0, PERSONA_PREVIEW)}…`
              : persona
            : "还没写人设"}
        </p>
      </Section>

      {/* 角色 P4「跟进我的会话」：自包含开关（包 C），设置页「例行」tab 也挂同一个 */}
      <Section icon={ListChecks} title="跟进">
        <RoleFollowToggle roleId={role.id} roleName={role.name} className="px-3 py-2.5" />
      </Section>
    </div>
  );
}

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: typeof Brain;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-1.5 px-0.5 text-[12.5px] font-medium text-ink-faint">
        <Icon icon={icon} size="sm" />
        {title}
        <span className="ml-auto">{action}</span>
      </h2>
      <div className="ui-enter-up overflow-hidden rounded-card bg-surface-raised shadow-raise">{children}</div>
    </section>
  );
}

/** 桌面右栏：≥1280px 才出，出来就发布 --trellis-rp 让线性视图让位。 */
export function RoleGlancePanel({ role }: { role: Role }) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (wide) root.style.setProperty("--trellis-rp", PANEL_W);
    else root.style.removeProperty("--trellis-rp");
    return () => {
      root.style.removeProperty("--trellis-rp");
    };
  }, [wide]);

  if (!wide) return null;
  return (
    <aside
      data-role-glance-panel
      aria-label={`${role.name}：一览`}
      className="fixed right-0 z-20 overflow-y-auto border-l border-line bg-surface-canvas md:bg-surface px-4 pt-4 pb-10"
      style={{
        width: PANEL_W,
        top: "calc(5.25rem + var(--trellis-pending-h, 0px))",
        bottom: "var(--trellis-term-h, 0px)",
      }}
    >
      <RoleGlanceContent role={role} />
    </aside>
  );
}
