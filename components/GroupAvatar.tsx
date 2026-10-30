"use client";
import { cn } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { roleAvatarBackground } from "@/lib/roles";
import type { GroupMember } from "@/lib/groups";

// 群聊头像（原型 09-roles.html .grav / .rav-stack）：
//   GroupAvatar —— 侧栏行里的四宫格：前 4 位成员的色相各占一格（不足 4 位的格子留给第一位补齐）；
//   GroupAvatarStack —— 顶栏 / 手机首页的叠放圆头像。

const GRID_SIZE = { xs: "size-5 rounded-[6px]", sm: "size-6 rounded-[7px]", lg: "size-10 rounded-[11px]" } as const;

export function GroupAvatar({
  members,
  size = "xs",
  className,
}: {
  members: Pick<GroupMember, "avatarHue">[];
  size?: keyof typeof GRID_SIZE;
  className?: string;
}) {
  const hues = members.slice(0, 4).map((m) => m.avatarHue);
  while (hues.length < 4) hues.push(hues[hues.length % Math.max(1, hues.length)] ?? 254);
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-2 gap-px overflow-hidden", GRID_SIZE[size], className)}>
      {hues.map((h, i) => (
        <i key={i} className="block" style={{ background: roleAvatarBackground(h) }} />
      ))}
    </span>
  );
}

export function GroupAvatarStack({
  members,
  max = 3,
  size = "sm",
  className,
}: {
  members: Pick<GroupMember, "roleId" | "avatarHue" | "avatarGlyph" | "name">[];
  max?: number;
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("inline-flex shrink-0", className)}>
      {members.slice(0, max).map((m, i) => (
        <RoleAvatar key={m.roleId} role={m} size={size} className={cn("ring-2 ring-surface", i > 0 && "-ml-[7px]")} />
      ))}
    </span>
  );
}
