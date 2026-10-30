"use client";
import { useState } from "react";
import { FolderOpen, Minus, Plus, Settings, X } from "lucide-react";
import { Button, Icon, IconButton, Popover, Tooltip, cn, toast } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { GroupAvatarStack } from "./GroupAvatar";
import { useGroupStore } from "@/stores/groupStore";
import { useRoleStore } from "@/stores/roleStore";
import { BUTLER_AGENT_ID } from "@/lib/butler";
import { useSessionStore } from "@/stores/sessionStore";
import {
  GROUP_MAX_MEMBERS,
  GROUP_MESSAGES_RANGE,
  GROUP_MIN_MEMBERS,
  GROUP_PASSES_RANGE,
  GROUP_POLICIES,
  GROUP_POLICY_LABEL,
  type Group,
  type GroupPatch,
} from "@/lib/groups";

// 群聊顶栏（原型 09-roles.html s-group .topbar）：叠放头像 + 群名 +「N 位角色 · 你」，
// 右侧工作目录 chip + 齿轮（群设置弹层：没人 @ 时的策略、每轮上限、成员增减）。
// Header.tsx 只在群会话里挂这几件，其余视图一字不动。

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

/** 桌面面包屑位置的群名片。 */
export function GroupHeaderTitle({ group }: { group: Group }) {
  return (
    <span data-header-group={group.id} className="-ml-1.5 flex min-w-0 items-center gap-2.5 px-1.5 py-1">
      <GroupAvatarStack members={group.members} />
      <span className="flex min-w-0 items-baseline gap-2">
        <span data-header-title className="shrink-0 text-[14px] font-semibold text-ink">
          {group.name}
        </span>
        <span className="min-w-0 truncate text-label text-ink-faint">{group.members.length} 位角色 · 你</span>
      </span>
    </span>
  );
}

/** 手机顶栏中间：头像叠 + 群名 + 副标题。 */
export function GroupHeaderMobile({ group, networkTitle }: { group: Group; networkTitle: string | null }) {
  return (
    <span data-header-group={group.id} className="flex min-h-11 min-w-0 items-center gap-2 px-2">
      <GroupAvatarStack members={group.members} max={3} size="xs" />
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span data-header-title className="max-w-full truncate text-ui font-semibold text-ink-strong">
          {group.name}
        </span>
        {networkTitle ? (
          <span data-header-network className="truncate text-nano text-warn-ink">{networkTitle}</span>
        ) : (
          <span className="max-w-full truncate text-nano text-ink-faint">{group.members.length} 位角色 · 你</span>
        )}
      </span>
    </span>
  );
}

function Stepper({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  onChange: (v: number) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <IconButton size="sm" label={`${label}减一`} disabled={value <= range[0]} onClick={() => onChange(value - 1)}>
        <Icon icon={Minus} size="sm" />
      </IconButton>
      <b className="w-5 text-center font-semibold tabular-nums text-ink">{value}</b>
      <IconButton size="sm" label={`${label}加一`} disabled={value >= range[1]} onClick={() => onChange(value + 1)}>
        <Icon icon={Plus} size="sm" />
      </IconButton>
    </span>
  );
}

/** 群设置弹层的正文（桌面 Popover / 手机同一份）。 */
export function GroupSettingsBody({ group }: { group: Group }) {
  const update = useGroupStore((s) => s.update);
  const roles = useRoleStore((s) => s.roles);
  const [adding, setAdding] = useState(false);
  const apply = async (patch: GroupPatch) => {
    const r = await update(group.id, patch);
    if (typeof r === "string") toast.error(r);
  };
  const s = group.settings;
  const candidates = roles.filter(
    (r) => r.enabled && r.id !== BUTLER_AGENT_ID && !group.members.some((m) => m.roleId === r.id),
  );
  const full = group.members.length >= GROUP_MAX_MEMBERS;

  return (
    <div data-group-settings className="flex flex-col text-ui">
      <div className="mb-1.5 text-label font-medium text-ink-faint">没人被 @ 的时候</div>
      <div role="radiogroup" aria-label="没人被 @ 的时候" className="flex flex-col">
        {GROUP_POLICIES.map((p) => {
          const on = s.replyPolicy === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={on}
              data-group-policy={p}
              onClick={() => !on && void apply({ settings: { replyPolicy: p } })}
              className="flex items-start gap-2.5 rounded-field p-2 text-left hover:bg-surface-hover max-md:min-h-11"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 size-4 shrink-0 rounded-full",
                  on ? "shadow-[inset_0_0_0_5px_var(--color-accent)]" : "shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]",
                )}
              />
              <span className="min-w-0">
                <span className="block font-medium text-ink">{GROUP_POLICY_LABEL[p].title}</span>
                <span className="block text-label text-ink-faint">{GROUP_POLICY_LABEL[p].desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      <hr className="my-2 border-line" />
      <div className="mb-1 text-label font-medium text-ink-faint">每轮上限</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-label text-ink-muted">
        <Stepper label="来回" value={s.maxPasses} range={GROUP_PASSES_RANGE} onChange={(v) => void apply({ settings: { maxPasses: v } })} />
        <span>遍</span>
        <Stepper label="最多" value={s.maxMessages} range={GROUP_MESSAGES_RANGE} onChange={(v) => void apply({ settings: { maxMessages: v } })} />
        <span>条</span>
      </div>
      <hr className="my-2 border-line" />
      <div className="mb-1 text-label font-medium text-ink-faint">成员</div>
      <div className="flex flex-col">
        {group.members.map((m) => (
          <div key={m.roleId} className="group/m flex min-h-9 items-center gap-2 rounded-field px-2 hover:bg-surface-hover">
            <RoleAvatar role={m} size="xs" />
            <span className="min-w-0 flex-1 truncate text-ink">{m.name}</span>
            {group.members.length > GROUP_MIN_MEMBERS && (
              <IconButton
                size="sm"
                label={`让${m.name}退群`}
                onClick={() => void apply({ removeRoleIds: [m.roleId] })}
                className="opacity-0 group-hover/m:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              >
                <Icon icon={X} size="sm" />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <div className="mt-1 flex max-h-48 flex-col overflow-y-auto rounded-card bg-surface-muted p-1 shadow-hairline">
          {candidates.length === 0 ? (
            <span className="px-2 py-1.5 text-label text-ink-faint">没有可以加的角色了</span>
          ) : (
            candidates.map((r) => (
              <button
                key={r.id}
                type="button"
                data-group-add-role={r.id}
                onClick={() => {
                  setAdding(false);
                  void apply({ addRoleIds: [r.id] });
                }}
                className="flex min-h-9 items-center gap-2 rounded-field px-2 text-left hover:bg-surface-hover max-md:min-h-11"
              >
                <RoleAvatar role={r} size="xs" />
                <span className="min-w-0 truncate text-ink">{r.name}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={full}
          onClick={() => {
            setAdding(true);
            if (roles.length === 0) void useRoleStore.getState().refresh();
          }}
          className="mt-1 justify-start"
        >
          <Icon icon={Plus} size="sm" />
          加角色（最多 {GROUP_MAX_MEMBERS} 位）
        </Button>
      )}
    </div>
  );
}

/** 桌面顶栏右侧：工作目录 chip + 群设置齿轮。 */
export function GroupHeaderActions({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  const setWorkspaceFilesOpen = useSessionStore((s) => s.setWorkspaceFilesOpen);
  return (
    <div data-header-group-actions className="flex shrink-0 items-center gap-1.5">
      {group.workDir && (
        <Tooltip content={`${group.workDir}（点击浏览文件）`}>
          <button
            type="button"
            data-header-workspace
            onClick={() => setWorkspaceFilesOpen(true)}
            className="inline-flex h-6 max-w-44 shrink-0 items-center gap-1 rounded-chip bg-surface-muted px-2 text-[11.5px] text-ink-muted shadow-hairline transition-colors duration-100 hover:bg-surface-hover hover:text-ink max-md:hidden"
          >
            <Icon icon={FolderOpen} size="sm" className="size-3 shrink-0 text-ink-faint" />
            <span className="truncate font-mono">{basename(group.workDir)}</span>
          </button>
        </Tooltip>
      )}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        panelClassName="w-[300px] p-3"
        trigger={
          <IconButton
            label="群设置"
            aria-expanded={open}
            data-group-settings-btn
            onClick={() => setOpen((v) => !v)}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <Icon icon={Settings} />
          </IconButton>
        }
      >
        <GroupSettingsBody group={group} />
      </Popover>
    </div>
  );
}
