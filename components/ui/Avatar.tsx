import { cn } from "./cn";
import { roleAvatarBackground, roleGlyph, type Role } from "@/lib/roles";

// 角色头像：色相渐变圆 + 一个字。渐变走内联 oklch（不写 hex，过 ui-source-guard），
// 色相来自 agents.avatar_hue。status 是右下角的在线 / 忙碌点。

const SIZE = {
  xs: "size-5 text-[10px]",
  sm: "size-6 text-[11px]",
  md: "size-7 text-xs",
  lg: "size-10 text-base",
  xl: "size-16 text-2xl",
} as const;

export type AvatarSize = keyof typeof SIZE;

export function RoleAvatar({
  role,
  size = "md",
  status,
  className,
}: {
  role: Pick<Role, "avatarHue" | "avatarGlyph" | "name">;
  size?: AvatarSize;
  status?: "online" | "busy";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-full font-semibold text-white",
        "shadow-[inset_0_0_0_1px_oklch(100%_0_0/0.18)]",
        SIZE[size],
        className,
      )}
      style={{ background: roleAvatarBackground(role.avatarHue) }}
    >
      {roleGlyph(role)}
      {status && (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-surface",
            status === "busy" ? "bg-warn ui-breathe-warn" : "bg-positive",
          )}
        />
      )}
    </span>
  );
}
