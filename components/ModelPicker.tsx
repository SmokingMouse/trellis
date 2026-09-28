"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ChevronDown, Cpu, History, Search, Settings, X } from "lucide-react";
import { Button, Icon, Input, Popover, SegmentedControl } from "@/components/ui";
import { ModelConfigModal } from "@/components/ModelConfigPanel";
import {
  PROVIDERS,
  FAMILY_LABELS,
  blockedFamilySwitch,
  providerFamily,
  contextWindowFor,
  getProviderBadge,
  formatContextWindow,
  type ProviderFamily,
  type ProviderId,
  type ProviderInfo,
} from "@/lib/llm";

const RECENT_MODELS_KEY = "trellis-recent-models";
const MAX_RECENTS = 4;

function readRecentModels(): ProviderId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function recordRecentModel(id: ProviderId) {
  if (typeof window === "undefined") return;
  try {
    const existing = readRecentModels().filter((m) => m !== id);
    const next = [id, ...existing].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    // ignore localStorage errors
  }
}

type FilterTab = "all" | "recent" | "claude" | "codex" | "third_party";

export function ModelPicker() {
  const provider = useSessionStore((s) => s.provider);
  const setProvider = useSessionStore((s) => s.setProvider);
  const catalog = useSessionStore((s) => s.providerCatalog);
  const sessionActive = useSessionStore((s) => s.session !== null);

  const [open, setOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [recentIds, setRecentIds] = useState<ProviderId[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRecentIds(readRecentModels());
      setSearch("");
      setActiveTab("all");
      setHighlightedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const current = catalog.find((p) => p.id === provider) ?? catalog[0] ?? PROVIDERS[0];
  const currentBadge = getProviderBadge(current.id);

  // Filtered list based on search and active tab
  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((p) => {
      // Tab filter
      if (activeTab === "recent") {
        if (!recentIds.includes(p.id)) return false;
      } else if (activeTab === "claude") {
        if (providerFamily(p.id) !== "claude") return false;
      } else if (activeTab === "codex") {
        if (providerFamily(p.id) !== "codex") return false;
      } else if (activeTab === "third_party") {
        const isNativeClaude = p.id.startsWith("claude-") || p.id === "claude";
        const isNativeCodex = p.id === "codex" || (p.id.startsWith("codex:") && !p.id.includes("·"));
        if (isNativeClaude || isNativeCodex || p.id === "mock") return false;
      }

      // Query filter
      if (!q) return true;
      const badge = getProviderBadge(p.id).toLowerCase();
      const id = p.id.toLowerCase();
      const label = p.label.toLowerCase();
      const short = p.shortLabel.toLowerCase();
      const note = (p.note ?? "").toLowerCase();
      return (
        id.includes(q) ||
        label.includes(q) ||
        short.includes(q) ||
        badge.includes(q) ||
        note.includes(q)
      );
    });
  }, [catalog, search, activeTab, recentIds]);

  // Keep highlighted index in range
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search, activeTab]);

  const handleSelect = (p: ProviderInfo) => {
    const noKey = p.hasKey === false;
    const familyLocked = sessionActive && blockedFamilySwitch(provider, p.id);
    if (noKey || familyLocked) return;

    setProvider(p.id as ProviderId);
    recordRecentModel(p.id as ProviderId);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (filteredProviders.length ? (i + 1) % filteredProviders.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) =>
        filteredProviders.length ? (i - 1 + filteredProviders.length) % filteredProviders.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredProviders[highlightedIndex]) {
        handleSelect(filteredProviders[highlightedIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Recent models for quick access
  const recentProviders = useMemo(() => {
    return recentIds
      .map((id) => catalog.find((p) => p.id === id))
      .filter((p): p is ProviderInfo => Boolean(p));
  }, [recentIds, catalog]);

  return (
    <>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        panelClassName="w-80 max-h-[30rem] flex flex-col text-sm overflow-hidden shadow-pop"
        trigger={
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={`切换模型，当前 ${current.shortLabel}`}
            aria-expanded={open}
            data-model-picker-trigger
            className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-field border border-line px-2 text-label text-ink transition-colors hover:bg-surface-hover aria-expanded:bg-surface-hover"
          >
            <Icon icon={Cpu} size="sm" className="text-ink-muted" />
            <span className="text-nano text-ink-faint">{currentBadge}</span>
            <span className="min-w-0 truncate font-mono">{current.shortLabel}</span>
            <Icon icon={ChevronDown} size="sm" className="text-ink-faint" />
          </button>
        }
      >
        {/* 顶部搜索框 */}
        <div className="p-2 border-b border-line shrink-0 bg-surface">
          <Input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索模型或厂商（如 opus、deepseek）"
            aria-label="搜索模型"
            leading={<Icon icon={Search} size="sm" />}
            trailing={
              search ? (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => setSearch("")}
                  className="inline-flex text-ink-faint hover:text-ink"
                >
                  <Icon icon={X} size="sm" />
                </button>
              ) : undefined
            }
          />

          {/* 分类筛选标签 */}
          <SegmentedControl<FilterTab>
            aria-label="模型分类"
            size="sm"
            fullWidth
            className="mt-2"
            value={activeTab}
            onValueChange={setActiveTab}
            options={[
              { value: "all", label: "全部" },
              ...(recentProviders.length > 0 ? [{ value: "recent" as const, label: "常用" }] : []),
              { value: "claude", label: "Claude 系" },
              { value: "codex", label: "Codex 系" },
              { value: "third_party", label: "第三方" },
            ]}
          />
        </div>

        {/* 模型列表 */}
        <div className="flex-1 overflow-y-auto divide-y divide-line-faint">
          {/* 无搜索且全部 Tab 时，展示最近使用 */}
          {!search && activeTab === "all" && recentProviders.length > 0 && (
            <div className="p-2 bg-surface-muted/30 border-b border-line-faint">
              <div className="text-nano font-medium text-ink-faint px-1 mb-1.5 flex items-center gap-1">
                <Icon icon={History} size="sm" />
                <span>最近使用</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {recentProviders.map((rp) => {
                  const active = rp.id === provider;
                  const noKey = rp.hasKey === false;
                  const familyLocked = sessionActive && blockedFamilySwitch(provider, rp.id);
                  const disabled = noKey || familyLocked;
                  return (
                    <button
                      key={`recent-${rp.id}`}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleSelect(rp)}
                      className={`px-2 py-1 text-nano rounded-md border flex items-center gap-1 transition-colors ${
                        active
                          ? "border-accent-line bg-accent-muted text-accent-ink font-medium"
                          : disabled
                            ? "border-line/40 opacity-40 cursor-not-allowed bg-surface"
                            : "border-line bg-surface hover:bg-surface-muted text-ink-strong"
                      }`}
                    >
                      <span className="opacity-60 font-mono">[{getProviderBadge(rp.id)}]</span>
                      <span className="truncate max-w-[8rem]">{rp.shortLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {filteredProviders.length === 0 ? (
            <div className="p-6 text-center text-ink-faint">
              <div className="text-ui mb-1">未找到匹配的模型</div>
              <div className="text-label text-ink-muted mb-3">
                {search ? `没有包含「${search}」的模型` : "当前分类下暂无模型"}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setConfigOpen(true);
                }}
              >
                添加或配置模型
              </Button>
            </div>
          ) : (
            filteredProviders.map((p, idx) => {
              const active = p.id === provider;
              const isHighlighted = idx === highlightedIndex;
              const noKey = p.hasKey === false;
              const familyLocked = sessionActive && blockedFamilySwitch(provider, p.id);
              const disabled = noKey || familyLocked;
              const badge = getProviderBadge(p.id);
              const winTokens = contextWindowFor(p.id as ProviderId);
              const winText = formatContextWindow(winTokens);

              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleSelect(p)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  title={
                    noKey
                      ? "缺少 API 密钥，尚未配置"
                      : familyLocked
                        ? "跨系会丢失本会话上下文 — 请新建会话再选"
                        : undefined
                  }
                  className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors ${
                    disabled
                      ? "opacity-40 cursor-not-allowed bg-surface"
                      : isHighlighted || active
                        ? "bg-surface-muted"
                        : "hover:bg-surface-muted"
                  }`}
                >
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                      active ? "bg-accent" : disabled ? "bg-line-strong" : "bg-line-strong/60"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-nano font-mono px-1 py-0.5 rounded bg-surface border border-line text-ink-muted">
                        {badge}
                      </span>
                      <span className="text-ui font-medium text-ink-strong truncate">
                        {p.shortLabel}
                      </span>
                      {active && (
                        <span className="text-nano text-accent-ink font-medium ml-auto shrink-0">
                          当前
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 mt-0.5 text-label text-ink-faint truncate">
                      <span title={`上下文窗口 ~${winTokens.toLocaleString()} tokens`}>
                        上下文 {winText}
                      </span>
                      {(p.note || familyLocked || noKey) && (
                        <>
                          <span>·</span>
                          <span
                            className={
                              familyLocked || noKey
                                ? "text-danger-ink"
                                : "text-ink-faint"
                            }
                          >
                            {noKey ? "缺少密钥" : familyLocked ? "跨系 · 需新会话" : p.note}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 底部管理入口 */}
        <div className="p-2 border-t border-line shrink-0 bg-surface flex items-center justify-between">
          <div className="text-nano text-ink-faint px-1">
            共 {catalog.length} 个可用模型
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setConfigOpen(true);
            }}
          >
            <Icon icon={Settings} size="sm" />
            管理模型与服务商…
          </Button>
        </div>
      </Popover>

      {configOpen && <ModelConfigModal onClose={() => setConfigOpen(false)} />}
    </>
  );
}
