"use client";
import { AtSign, ChevronDown, ChevronRight, CornerDownRight, MessagesSquare, Sparkles, SquareSlash, type LucideIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Icon } from "@/components/ui";
import type { Command } from "@/lib/commands";
import { refSessionLabel, type RefPickItem } from "@/hooks/useNodeRefMentions";
import { RoleAvatar } from "@/components/ui/Avatar";

// C4/C1: shared "/" suggestion dropdown for input boxes — Trellis commands
// (first-class, all modes) render above skills (tool-capable modes only).
// placement="above" pops upward (bottom-full) for the docked composers;
// "inline" flows under the first-screen QuestionInput. Renders nothing when
// there are no matches.
//
// activeIndex is the keyboard highlight from useSlashNav, in the combined
// commands-then-skills index space (matching render order).
//
// 行样式（W3）：行首 lucide 图标区分身份（命令 / 单轮 Agent / 技能），名字等宽，
// 行尾弱化文字标注类别；不再用 emoji 徽章。
export function SkillPickerList({
  skills,
  onPick,
  commands = [],
  onPickCommand,
  agents = [],
  onPickAgent,
  activeIndex = -1,
  skillPrefix = "/",
  placement = "above",
  slashItems = [],
  onPickSlashItem,
  refItems = [],
  onPickRef,
  refExpandedId = null,
  refExpandedLoading = false,
  onToggleRefExpand,
}: {
  skills: { name: string; description: string }[];
  onPick: (name: string) => void;
  commands?: Command[];
  onPickCommand?: (command: Command) => void;
  // S88: `@slug` 提及 —— 把这一轮定向丢给某个 Agent。与 commands/skills
  // **互斥出现**（前两者绑开头的 `/`，这个绑开头的 `@`），所以索引空间不重叠，
  // agents 分组的 activeIndex 直接从 0 起算，不必再叠加偏移。
  agents?: { slug: string; name: string; description: string }[];
  onPickAgent?: (slug: string) => void;
  activeIndex?: number;
  skillPrefix?: "/" | "$";
  placement?: "above" | "inline";
  // Herdr 输入框：Claude Code 自己的斜杠命令（内置 / 技能 / 自定义命令），名字已含前缀。
  // 排在 commands + skills 之后（Herdr 里那两组为空，索引即从 0 起）。
  slashItems?: { name: string; description: string; kindLabel: string; kind: "command" | "skill" }[];
  onPickSlashItem?: (index: number) => void;
  // `@` 引用其他会话 / 节点（hooks/useNodeRefMentions）。只和 agents 同屏（都绑 `@`），
  // 排在 agents 之后，索引从 agents.length 起算。会话行 = 引用该会话最新已完成节点，
  // 行尾展开钮列出具体节点改选（展开的节点行紧跟在会话行之后，同属这个索引空间）。
  refItems?: RefPickItem[];
  onPickRef?: (item: RefPickItem) => void;
  refExpandedId?: string | null;
  refExpandedLoading?: boolean;
  onToggleRefExpand?: (sessionId: string) => void;
}) {
  if (!skills.length && !commands.length && !agents.length && !slashItems.length && !refItems.length) return null;
  // Keep the keyboard highlight visible inside the scrollable list. Ref
  // callbacks re-run per render, but scrollIntoView(nearest) on an already
  // visible element is a no-op.
  const activeRef = (el: HTMLButtonElement | null) =>
    el?.scrollIntoView({ block: "nearest" });
  const row = ({
    key,
    active,
    onClick,
    icon,
    name,
    extra,
    kind,
    description,
  }: {
    key: string;
    active: boolean;
    onClick: () => void;
    icon: LucideIcon;
    name: string;
    extra?: ReactNode;
    kind: string;
    description?: string;
  }) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={active}
      ref={active ? activeRef : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`press-row w-full min-h-9 text-left px-2 py-1.5 rounded-[7px] flex items-center gap-2.5 transition-colors duration-100 max-md:min-h-11 ${
        active ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      <IconTile icon={icon} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 text-ui">
        <span className="shrink-0 font-mono font-medium text-ink">{name}</span>
        {extra}
        {description && (
          <span className="min-w-0 flex-1 truncate text-label text-ink-faint">{description}</span>
        )}
        <span className="ml-auto shrink-0 pl-1 text-nano text-ink-faint">{kind}</span>
      </span>
    </button>
  );
  return (
    <div
      role="listbox"
      aria-label="命令与技能"
      className={`${
        placement === "above" ? "absolute bottom-full inset-x-0 mb-2 z-10 origin-bottom-left" : "mt-2 origin-top-left"
      } ui-enter-pop rounded-card bg-surface-raised shadow-pop p-1 max-h-72 max-md:max-h-[min(18rem,40svh)] overflow-y-auto overscroll-contain`}
    >
      {commands.map((c, i) =>
        row({
          key: `cmd-${c.name}`,
          active: i === activeIndex,
          onClick: () => onPickCommand?.(c),
          icon: SquareSlash,
          name: `/${c.name}`,
          extra: c.hint ? <span className="shrink-0 font-mono text-label text-ink-faint">{c.hint}</span> : undefined,
          kind: "命令",
          description: c.description,
        }),
      )}
      {agents.map((a, i) =>
        row({
          key: `agent-${a.slug}`,
          active: i === activeIndex,
          onClick: () => onPickAgent?.(a.slug),
          icon: AtSign,
          name: `@${a.slug}`,
          extra: <span className="shrink-0 text-label text-ink-muted">{a.name}</span>,
          kind: "单轮 Agent",
          description: a.description,
        }),
      )}
      {refItems.length > 0 && agents.length > 0 && (
        <div role="presentation" className="px-2 pt-2 pb-1 text-nano font-medium text-ink-faint">
          引用会话作为上下文
        </div>
      )}
      {refItems.map((item, i) => {
        const active = agents.length + i === activeIndex;
        if (item.kind === "node") {
          const n = item.node;
          return (
            <button
              key={`ref-node-${n.nodeId}`}
              type="button"
              role="option"
              aria-selected={active}
              ref={active ? activeRef : undefined}
              data-node-ref-option={n.nodeId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPickRef?.(item)}
              className={`press-row w-full min-h-9 text-left pl-10 pr-2 py-1.5 rounded-[7px] flex items-center gap-2 transition-colors duration-100 max-md:min-h-11 ${
                active ? "bg-surface-hover" : "hover:bg-surface-hover"
              }`}
            >
              <Icon icon={CornerDownRight} size="sm" className="text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-ui text-ink">
                <span className="font-mono text-label text-ink-faint tabular-nums mr-1.5">#{n.index}</span>
                <span className="truncate">{n.topicLabel ?? n.question.replace(/\s+/g, " ")}</span>
              </span>
            </button>
          );
        }
        const s = item.session;
        const expanded = refExpandedId === s.sessionId;
        const latest = s.latest;
        return (
          <Fragment key={`ref-session-${s.sessionId}`}>
          <div
            className={`flex items-stretch rounded-[7px] transition-colors duration-100 ${active ? "bg-surface-hover" : "hover:bg-surface-hover"}`}
          >
            <button
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={!latest}
              ref={active ? activeRef : undefined}
              data-node-ref-session={s.sessionId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (latest ? onPickRef?.(item) : onToggleRefExpand?.(s.sessionId))}
              className="min-w-0 flex-1 min-h-9 text-left px-2 py-1.5 flex items-center gap-2.5 max-md:min-h-11"
            >
              {s.role ? (
                <span className="grid size-6 shrink-0 place-items-center">
                  <RoleAvatar role={s.role} size="sm" />
                </span>
              ) : (
                <IconTile icon={MessagesSquare} />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5 text-ui text-ink">
                  <span className="min-w-0 truncate font-medium">{refSessionLabel(s)}</span>
                  {latest && <span className="shrink-0 font-mono text-label text-ink-faint tabular-nums">#{latest.index}</span>}
                  <span className="ml-auto shrink-0 text-nano text-ink-faint">
                    {s.sessionKind === "role" ? "角色" : s.sessionKind === "group" ? "群聊" : "会话"}
                  </span>
                </span>
                <span className="block text-label text-ink-faint truncate">
                  {latest ? (latest.topicLabel ?? latest.question.replace(/\s+/g, " ")) : "还没有已完成的回答"}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={expanded ? `收起「${s.title}」的节点` : `展开「${s.title}」，改选具体节点`}
              aria-expanded={expanded}
              title={expanded ? "收起" : "改选具体节点"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleRefExpand?.(s.sessionId)}
              className="shrink-0 inline-flex w-8 items-center justify-center rounded-[7px] text-ink-faint transition-colors duration-100 hover:text-ink max-md:w-11"
            >
              <Icon icon={expanded ? ChevronDown : ChevronRight} size="sm" />
            </button>
          </div>
          {expanded && refExpandedLoading && (
            <div role="presentation" className="pl-10 py-1.5 text-label text-ink-faint">
              载入节点…
            </div>
          )}
          </Fragment>
        );
      })}
      {skills.map((s, i) =>
        row({
          key: `skill-${s.name}`,
          active: commands.length + i === activeIndex,
          onClick: () => onPick(s.name),
          icon: Sparkles,
          name: `${skillPrefix}${s.name}`,
          kind: "技能",
          description: s.description,
        }),
      )}
      {slashItems.map((item, i) =>
        row({
          key: `slash-${item.name}`,
          active: commands.length + skills.length + i === activeIndex,
          onClick: () => onPickSlashItem?.(i),
          icon: item.kind === "skill" ? Sparkles : SquareSlash,
          name: item.name,
          kind: item.kindLabel,
          description: item.description,
        }),
      )}
    </div>
  );
}

/** bui 菜单行首的图标小方块：24px、surface-muted 底 + hairline。 */
function IconTile({ icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-chip bg-surface-muted text-ink-muted shadow-hairline"
    >
      <Icon icon={icon} size="sm" />
    </span>
  );
}
