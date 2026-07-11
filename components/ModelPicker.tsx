"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { PROVIDERS, type ProviderId } from "@/lib/llm";

export function ModelPicker() {
  const provider = useSessionStore((s) => s.provider);
  const setProvider = useSessionStore((s) => s.setProvider);
  // Live catalog from /api/providers (endpoints.yaml-backed); falls back to
  // the static PROVIDERS list until the fetch (fired from hydrate()) resolves.
  const catalog = useSessionStore((s) => s.providerCatalog);
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
        <div className="absolute right-0 mt-1.5 w-56 max-h-96 overflow-y-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-xl text-sm">
          {catalog.map((p) => {
            const active = p.id === provider;
            const disabled = p.hasKey === false;
            return (
              <button
                key={p.id}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setProvider(p.id as ProviderId);
                  setOpen(false);
                }}
                title={disabled ? "缺 API key，未配置" : undefined}
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
                  {p.note && (
                    <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
                      {p.note}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
