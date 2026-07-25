"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Popover } from "@/components/ui/Popover";
import { ModelConfigModal } from "@/components/ModelConfigModal";
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
  const [configOpen, setConfigOpen] = useState(false);

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
    <>
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      panelClassName="w-64 max-h-96 overflow-y-auto text-sm"
      trigger={
        <button
          onClick={() => setOpen((o) => !o)}
          className="px-2.5 py-1 text-xs rounded-md bg-ink text-ink-inverse flex items-center gap-1.5 hover:bg-ink/90"
        >
          <span className="w-1.5 h-1.5 bg-positive rounded-full" />
          {current.shortLabel}
          <span className="text-ink-inverse/60">▾</span>
        </button>
      }
    >
      {groups.map((g) => (
        <div key={g.family}>
          <div className="px-3 pt-2 pb-1 text-nano font-medium uppercase tracking-wider text-ink-faint select-none">
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
                    : "hover:bg-surface-muted"
                } ${active ? "bg-surface-muted" : ""}`}
              >
                <span
                  className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                    active ? "bg-positive" : "bg-line-strong"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-ink-strong text-ui">{p.label}</div>
                  {(p.note || familyLocked) && (
                    <div className="text-label text-ink-faint mt-0.5">
                      {familyLocked ? "跨系 · 需新会话" : p.note}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
      <button
        onClick={() => {
          setOpen(false);
          setConfigOpen(true);
        }}
        className="w-full text-left px-3 py-2 border-t border-line text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong"
      >
        ⚙ 管理模型…
      </button>
    </Popover>
    {configOpen && <ModelConfigModal onClose={() => setConfigOpen(false)} />}
    </>
  );
}
