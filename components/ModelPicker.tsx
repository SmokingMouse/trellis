"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  PROVIDERS,
  FAMILY_LABELS,
  blockedFamilySwitch,
  providerFamily,
  type ProviderFamily,
  type ProviderId,
  type ProviderInfo,
} from "@/lib/llm";

// Stable display order for the family groups.
const FAMILY_ORDER: ProviderFamily[] = ["claude", "codex", "mock"];

export function ModelPicker() {
  const provider = useSessionStore((s) => s.provider);
  const setProvider = useSessionStore((s) => s.setProvider);
  // Live catalog from /api/providers (endpoints.yaml-backed); falls back to
  // the static PROVIDERS list until the fetch (fired from hydrate()) resolves.
  const catalog = useSessionStore((s) => s.providerCatalog);
  // Session-family lock: while a session is loaded, its next turn will run as
  // `provider` — cross-family entries are disabled so the resume chain can't
  // be silently broken mid-conversation. On the new-session screen (no
  // session) every family is selectable: that's where the family choice
  // belongs.
  const sessionActive = useSessionStore((s) => s.session !== null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = catalog.find((p) => p.id === provider) ?? catalog[0] ?? PROVIDERS[0];

  const groups = useMemo(() => {
    const byFamily = new Map<ProviderFamily, ProviderInfo[]>();
    for (const p of catalog) {
      const fam = providerFamily(p.id);
      const arr = byFamily.get(fam) ?? [];
      arr.push(p);
      byFamily.set(fam, arr);
    }
    return FAMILY_ORDER.filter((f) => byFamily.has(f)).map((f) => ({
      family: f,
      providers: byFamily.get(f)!,
    }));
  }, [catalog]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 py-1 text-xs rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 flex items-center gap-1.5 hover:bg-stone-800 dark:hover:bg-stone-300"
      >
        <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
        {current.shortLabel}
        <span className="text-stone-400 dark:text-stone-500">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-64 max-h-96 overflow-y-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-xl text-sm">
          {groups.map((g) => (
            <div key={g.family}>
              <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 select-none">
                {FAMILY_LABELS[g.family]}
              </div>
              {g.providers.map((p) => {
                const active = p.id === provider;
                const noKey = p.hasKey === false;
                const familyLocked =
                  sessionActive && blockedFamilySwitch(provider, p.id);
                const disabled = noKey || familyLocked;
                return (
                  <button
                    key={p.id}
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      setProvider(p.id as ProviderId);
                      setOpen(false);
                    }}
                    title={
                      noKey
                        ? "缺 API key，未配置"
                        : familyLocked
                          ? "跨系会丢失本会话上下文 — 请新建会话再选"
                          : undefined
                    }
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 ${
                      disabled
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:bg-stone-50 dark:hover:bg-stone-800"
                    } ${active ? "bg-stone-50 dark:bg-stone-800/60" : ""}`}
                  >
                    <span
                      className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                        active ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-stone-900 dark:text-stone-100 text-[13px]">{p.label}</div>
                      {(p.note || familyLocked) && (
                        <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
                          {familyLocked ? "跨系 · 需新会话" : p.note}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
