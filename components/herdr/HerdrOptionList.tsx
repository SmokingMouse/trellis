"use client";

// 选择卡的选项列表：HerdrInteractionCard（发按键 / 读屏路径）与 HerdrBlockingCard
// （阻塞 hook 的结构化作答）共用。从 HerdrInteractionCard.tsx 原样搬出来，渲染不变。
import { Square, SquareCheck } from "lucide-react";
import { Badge, Icon, cn } from "@/components/ui";
import type { HerdrAskOption, HerdrAskQuestion } from "@/lib/herdr-console";

const RECOMMENDED = /\s*[（(]\s*(推荐|recommended)\s*[)）]\s*$/i;

export function options(question: HerdrAskQuestion): HerdrAskOption[] {
  return Array.isArray(question.options)
    ? (question.options as HerdrAskOption[])
    : [];
}

export type OptionItem = {
  key: string;
  /** TUI 序号（1 起） */
  index: number;
  label: string;
  description?: string;
  recommended?: boolean;
  checked?: boolean;
};

/**
 * 选项卡片列表：hook 路径（AskUserQuestion tool_input）与读屏路径共用这一套。
 * 纵向列表：标题 + 弱色描述 + 「推荐」标记；宽的会话卡在 sm 以上两列。
 */
export function OptionList({
  items,
  columns,
  clampDescription,
  multiSelect = false,
  disabled,
  onPick,
}: {
  items: OptionItem[];
  columns: boolean;
  /** 总览卡里描述只留一行（悬停看全文） */
  clampDescription: boolean;
  multiSelect?: boolean;
  disabled: boolean;
  onPick: (item: OptionItem) => void;
}) {
  return (
    <div className={cn("-mx-2 mt-1.5 grid gap-0.5", columns && "sm:grid-cols-2 sm:gap-1")}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          data-herdr-option={item.index}
          data-mobile-target="herdr-option"
          aria-pressed={multiSelect ? item.checked === true : undefined}
          disabled={disabled}
          onClick={() => onPick(item)}
          title={item.description ? `${item.label}\n${item.description}` : item.label}
          className={cn(
            // bui Approval Card 的选项行：无框，选中 = accent 淡底；推荐项靠「推荐」徽标说
            "flex min-h-11 min-w-0 items-start gap-2.5 rounded-field px-2 py-[9px] text-left text-ui text-ink transition-colors disabled:opacity-60 sm:min-h-[38px]",
            item.checked ? "bg-accent-muted" : "hover:bg-surface-hover",
          )}
        >
          {multiSelect ? (
            <span className="grid size-5 shrink-0 place-items-center">
              <Icon
                icon={item.checked ? SquareCheck : Square}
                size="sm"
                className={item.checked ? "text-accent" : "text-ink-faint"}
              />
            </span>
          ) : (
            // 序号徽标（就是要发给终端的那个键）
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-chip font-mono text-nano tabular-nums",
                item.checked ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted shadow-hairline",
              )}
            >
              {item.index}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13.5px] leading-5">{item.label}</span>
              {item.recommended && (
                <Badge variant="accent" className="shrink-0">推荐</Badge>
              )}
            </span>
            {item.description && (
              <span
                className={cn(
                  "mt-0.5 block text-label text-ink-faint",
                  clampDescription && "truncate",
                )}
              >
                {item.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

export function hookItems(question: HerdrAskQuestion, selected: number[]): OptionItem[] {
  return options(question).map((option, index) => {
    const raw = typeof option.label === "string" ? option.label : `选项 ${index + 1}`;
    return {
      key: `${index}:${raw}`,
      index: index + 1,
      label: raw.replace(RECOMMENDED, "").trim() || raw,
      recommended: RECOMMENDED.test(raw),
      description:
        typeof option.description === "string" && option.description
          ? option.description
          : undefined,
      checked: selected.includes(index),
    };
  });
}

