"use client";

// 「下一句发去哪」的统一目标指示 chip —— 画布 DockedComposer（回复 #N）与
// 线性视图分叉 chip（⑂ 从 #N 分叉）此前各长一样，视图切换要重学；现共用
// 本组件（accent 淡底 + 描边的同一外壳），只在文案/动作上分化。
export function TargetChip({
  icon,
  verb,
  index,
  suffix,
  label,
  hint,
  onLabelClick,
  onClear,
}: {
  icon: string;
  verb: string; // 动词前缀：「回复」/「从」
  index: number | string;
  suffix?: string; // 紧跟编号的动词后半：「分叉」
  label: string;
  hint?: string;
  onLabelClick?: () => void;
  onClear?: () => void;
}) {
  const body = (
    <>
      {verb} <span className="font-mono tabular-nums">#{index}</span>
      {suffix ? ` ${suffix}` : ""} ·{" "}
      <span className="text-accent-ink/90">{label}</span>
    </>
  );
  return (
    <div className="mt-2 -mb-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent-line bg-accent-muted text-xs text-accent-ink">
      <span aria-hidden>{icon}</span>
      {onLabelClick ? (
        <button
          type="button"
          onClick={onLabelClick}
          className="min-w-0 flex-1 text-left truncate hover:underline"
          title="定位到该节点"
        >
          {body}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate">{body}</span>
      )}
      {hint && (
        <span className="hidden sm:inline shrink-0 text-accent-ink/60">
          {hint}
        </span>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 px-1 rounded hover:bg-accent-line/40"
          title="取消 (Esc)"
          aria-label="取消"
        >
          ✕
        </button>
      )}
    </div>
  );
}
