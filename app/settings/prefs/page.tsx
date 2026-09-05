"use client";
import { useEffect, useState } from "react";
import { PREF_ITEMS, readRaw, writeRaw, type PrefItem } from "@/lib/prefs";

// S89: 偏好的「可穷举清单」。
//
// 这一页**不是**把原地控件搬过来 —— 主题仍在 ThemeMenu、发送键仍在输入框脚注、宽度仍在
// 线性视图顶栏，一个都没动。它解决的是另一个问题：偏好有二十多个、全部只存在于语境化的
// popover 里，于是「我知道有这个设置，但想不起在哪改」时无处可去。所以每一行都标着
// **原本在哪改**（where）—— 清单的作用是指路，指路比取代重要。
//
// 见 decisions/2026-07-31-console-ia.md 决策 5：这修订了 decisions.md 2026-07-29
// 「偏好类不搬进来」的一半（不搬家仍然对，"偏好少所以不需要穷举"已经不成立）。

const GROUPS = ["外观", "输入", "版式", "新会话默认"] as const;

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
    writeRaw(key, value);
    setValues((v) => ({ ...(v ?? {}), [key]: value }));
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="px-3 py-2 rounded-md border border-line bg-surface-muted text-label text-ink-muted">
        这些偏好各自都有就近的入口（每行右侧标注了在哪），这里只是一份能一次看全的清单。
        改动存在本浏览器，换设备不同步。部分改动要刷新页面才完全生效。
      </div>

      {GROUPS.map((g) => {
        const items = PREF_ITEMS.filter((i) => i.group === g);
        if (!items.length) return null;
        return (
          <section
            key={g}
            className="rounded-card border border-line bg-surface shadow-raise p-4"
          >
            <h2 className="text-ui font-medium mb-3">{g}</h2>
            <div className="flex flex-col divide-y divide-line-faint">
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
    <div className="py-2.5 flex items-center gap-3 max-md:flex-col max-md:items-stretch">
      <div className="min-w-0 flex-1">
        <div className="text-ui">{item.label}</div>
        <div className="text-label text-ink-faint">在这改：{item.where}</div>
      </div>
      <div className="shrink-0 max-md:w-full">
        {!ready ? (
          <span className="text-label text-ink-faint">…</span>
        ) : item.kind === "enum" ? (
          <select
            className="px-2 py-1 max-md:w-full rounded-field border border-line bg-surface-muted text-ui text-ink outline-none"
            value={raw ?? item.fallback}
            onChange={(e) => onChange(e.target.value)}
          >
            {item.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : item.kind === "bool" ? (
          <input
            type="checkbox"
            checked={raw === null ? item.fallback : raw === "1" || raw === "true"}
            // 值的写法跟着既有存储走：这些 key 历史上存的是 "1"/"0"，
            // 不趁机改格式 —— 改了老浏览器里的旧值会被读成 false。
            onChange={(e) => onChange(e.target.checked ? "1" : "0")}
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
