"use client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { RoleAvatar, Select, cn } from "@/components/ui";
import { ROLE_AVATAR_HUES } from "@/lib/roles";
import type { ProviderInfo } from "@/lib/llm/providers";

// 新建弹窗和角色设置页共用的表单件。agents 页的 Field 只是一个 div 标题，读屏念不出
// 输入框叫什么；这里 label 用 htmlFor 绑到控件上（children 拿到 id 自己挂）。

export function RoleField({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  /** 有就替换 hint、红字显示，并挂到控件的 aria-describedby */
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const note = error || hint;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-ui font-medium text-ink">
        {label}
      </label>
      <div>{children({ id, describedBy: note ? hintId : undefined })}</div>
      {note && (
        <div id={hintId} className={cn("text-label", error ? "text-danger-ink" : "text-ink-muted")}>
          {note}
        </div>
      )}
    </div>
  );
}

/** 头像色相：一排同字不同色的圆，选中的带 accent 圈。 */
export function RoleHuePicker({
  hue,
  name,
  glyph,
  onChange,
}: {
  hue: number;
  name: string;
  glyph: string;
  onChange: (hue: number) => void;
}) {
  return (
    <div role="radiogroup" aria-label="头像颜色" className="flex flex-wrap items-center gap-2">
      {ROLE_AVATAR_HUES.map((h) => {
        const on = h === hue;
        return (
          <button
            key={h}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`颜色 ${h}°`}
            onClick={() => onChange(h)}
            className={cn(
              "rounded-full p-0.5 transition-shadow duration-100 max-md:min-h-11 max-md:min-w-11 max-md:grid max-md:place-items-center",
              on ? "ring-2 ring-accent" : "hover:ring-2 hover:ring-line-strong",
            )}
          >
            <RoleAvatar role={{ avatarHue: h, avatarGlyph: glyph, name: name || "角" }} size="lg" />
          </button>
        );
      })}
    </div>
  );
}

// Radix Select 不允许空串 value：「跟随会话」用哨兵值（同 agents 页）。
const INHERIT = "__inherit__";
// 和 agents 页的快捷 chip 同一组：这些是 --model 能直接认的别名
const MODEL_ALIASES = ["haiku", "sonnet", "opus", "codex", "gpt-5.5"];

/** 模型下拉：跟随会话 + 常用别名 + /api/providers 的目录；当前值不在表里也保留一项。 */
export function RoleModelSelect({
  id,
  value,
  onChange,
}: {
  /** 有 id 就靠外面的 <label htmlFor> 命名；没有才退回 aria-label */
  id?: string;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  const [catalog, setCatalog] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/providers")
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((d: { providers?: ProviderInfo[] }) => alive && setCatalog(d.providers ?? []))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, []);

  const options = [{ value: INHERIT, label: "跟随会话" }];
  const seen = new Set<string>([INHERIT]);
  const push = (v: string, label: string) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    options.push({ value: v, label });
  };
  MODEL_ALIASES.forEach((m) => push(m, m));
  catalog.forEach((p) => push(p.shortLabel, `${p.label} (${p.shortLabel})`));
  if (value) push(value, value);

  return (
    <Select
      id={id}
      aria-label={id ? undefined : "模型"}
      value={value ?? INHERIT}
      onValueChange={(v) => onChange(v === INHERIT ? null : v)}
      options={options}
    />
  );
}
