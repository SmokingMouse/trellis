"use client";
import { useEffect, useState } from "react";
import { PREF_ITEMS, PREF_KEYS, readRaw, writeRaw, type PrefItem } from "@/lib/prefs";
import { enableDesktopNotify } from "@/lib/desktop-notify";
import { PageHeader, Select, Skeleton, Switch } from "@/components/ui";

// S89: 偏好的「可穷举清单」。
//
// 这一页**不是**把原地控件搬过来 —— 主题仍在 ThemeMenu、发送键仍在输入框脚注、宽度仍在
// 线性视图顶栏，一个都没动。它解决的是另一个问题：偏好有二十多个、全部只存在于语境化的
// popover 里，于是「我知道有这个设置，但想不起在哪改」时无处可去。所以每一行都标着
// **原本在哪改**（where）—— 清单的作用是指路，指路比取代重要。
//
// 见 decisions/2026-07-31-console-ia.md 决策 5：这修订了 decisions.md 2026-07-29
// 「偏好类不搬进来」的一半（不搬家仍然对，"偏好少所以不需要穷举"已经不成立）。

const GROUPS = ["外观", "启动", "输入", "提醒", "版式", "新会话默认"] as const;

export default function PrefsSettingsPage() {
  // localStorage 只在浏览器里有。先渲染骨架、挂载后再读，避免 SSR / 水合不一致。
  // setState 走 promise 回调而不是 effect 体内直接调 —— 与 app/settings/update/page.tsx:67
  // 同一个既定写法（否则 react-hooks/set-state-in-effect 判成同步 setState）。
  const [values, setValues] = useState<Record<string, string | null> | null>(null);

  useEffect(() => {
    void Promise.resolve().then(() => {
      const next: Record<string, string | null> = {};
      for (const it of PREF_ITEMS) next[it.key] = readRaw(it.key);
      setValues(next);
    });
  }, []);

  const set = (key: string, value: string) => {
    // 打开开关是一次用户手势 —— 浏览器只在手势里放行授权弹窗。
    if (key === PREF_KEYS.desktopNotify && value === "1") void enableDesktopNotify();
    writeRaw(key, value);
    setValues((v) => ({ ...(v ?? {}), [key]: value }));
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="偏好"
        count={PREF_ITEMS.length}
        countUnit="项"
        subtitle="各自都有就近入口（每行标注了在哪改），这里是一次看全的清单；存在本浏览器，换设备不同步，部分改动要刷新页面才完全生效"
      />

      {GROUPS.map((g) => {
        const items = PREF_ITEMS.filter((i) => i.group === g);
        if (!items.length) return null;
        return (
          <section key={g}>
            <h2 className="text-ui font-semibold text-ink-strong mb-2">{g}</h2>
            <div className="flex flex-col divide-y divide-line-faint rounded-card border border-line bg-surface px-4">
              {items.map((it) => (
                <Row
                  key={it.key}
                  item={it}
                  raw={values?.[it.key] ?? null}
                  ready={values !== null}
                  onChange={(v) => set(it.key, v)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Row({
  item,
  raw,
  ready,
  onChange,
}: {
  item: PrefItem;
  raw: string | null;
  ready: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="py-3 flex items-center gap-3 max-md:flex-col max-md:items-stretch">
      <div className="min-w-0 flex-1">
        <div className="text-ui">{item.label}</div>
        <div className="text-label text-ink-faint">在这改：{item.where}</div>
      </div>
      <div className="shrink-0 max-md:w-full">
        {!ready ? (
          <Skeleton className="h-6 w-28" />
        ) : item.kind === "enum" ? (
          <Select
            aria-label={item.label}
            className="md:w-44"
            value={raw ?? item.fallback}
            onValueChange={onChange}
            options={item.options.map((o) => ({ value: o.value, label: o.label }))}
          />
        ) : item.kind === "bool" ? (
          <Switch
            aria-label={item.label}
            checked={raw === null ? item.fallback : raw === "1" || raw === "true"}
            // 值的写法跟着既有存储走：这些 key 历史上存的是 "1"/"0"，
            // 不趁机改格式 —— 改了老浏览器里的旧值会被读成 false。
            onCheckedChange={(v) => onChange(v ? "1" : "0")}
          />
        ) : (
          // 新会话默认值：只读。在这里改没有意义 —— 那三个 picker 才是真入口，
          // 且它们要连带做一致性钳制（切 chat 清 workspace、选 agent 清 systemPrompt），
          // 这里单独写一个值只会造出不自洽的草稿。
          <span
            className="text-label text-ink-faint font-mono truncate max-w-[16rem] max-md:max-w-full inline-block align-bottom"
            title={raw ?? "未设置"}
          >
            {raw ?? "未设置"}
          </span>
        )}
      </div>
    </div>
  );
}
