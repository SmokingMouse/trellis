"use client";
import { useEffect, useState } from "react";
import type { ProviderInfo } from "@/lib/llm";
import { Button, ErrorCallout, Input, Select, toast } from "@/components/ui";

// 打标 / 起题模型配置卡（settings/models tab，与 AuthHealthCard 同级）。
// 节点话题标签与会话自动命名共用一条 CLI spawn 管道（lib/llm/topic.ts），
// 模型默认 claude=haiku / codex=本机默认；只路由部分模型的网关环境（企业
// 网关、自建 cpa 类）在这里覆盖。存服务端 app_settings（spawn 在服务端，
// localStorage 够不着），空值 = 回默认。生成本身 best-effort：配错模型的
// 后果只是标题静默保持首问截断，不影响对话。
//
// S112: 交互升级 —— 提供常用推荐快捷 Tag、可选下拉列表与自动填入，无需手动敲模型全称。

// Radix Select 不允许空串 value：「未从列表选」用哨兵值占位。
const NONE = "__none__";

type Settings = {
  label_model_claude: string | null;
  label_model_codex: string | null;
};

const CLAUDE_PRESETS = [
  { label: "默认 (haiku)", value: "" },
  { label: "haiku", value: "haiku" },
  { label: "claude-3-5-haiku-20241022", value: "claude-3-5-haiku-20241022" },
  { label: "claude-3-5-sonnet-20241022", value: "claude-3-5-sonnet-20241022" },
  { label: "sonnet", value: "sonnet" },
];

const CODEX_PRESETS = [
  { label: "默认 (本机默认)", value: "" },
  { label: "gpt-5.4-mini", value: "gpt-5.4-mini" },
  { label: "gpt-4o-mini", value: "gpt-4o-mini" },
  { label: "gpt-5.5", value: "gpt-5.5" },
];

export function LabelModelCard() {
  const [loaded, setLoaded] = useState(false);
  const [claude, setClaude] = useState("");
  const [codex, setCodex] = useState("");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [catalog, setCatalog] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/providers").then((r) => (r.ok ? r.json() : { providers: [] })),
    ])
      .then(([settingsData, providersData]) => {
        if (!alive) return;
        const s = (settingsData.settings ?? {}) as Settings;
        setClaude(s.label_model_claude ?? "");
        setCodex(s.label_model_codex ?? "");
        setSaved(s);
        setCatalog(providersData.providers ?? []);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err);
      });
    return () => {
      alive = false;
    };
  }, []);

  const dirty =
    saved !== null &&
    (claude.trim() !== (saved.label_model_claude ?? "") ||
      codex.trim() !== (saved.label_model_codex ?? ""));

  const save = async () => {
    setBusy(true);
    try {
      const entries: [keyof Settings, string][] = [
        ["label_model_claude", claude.trim()],
        ["label_model_codex", codex.trim()],
      ];
      const next: Settings = { label_model_claude: null, label_model_codex: null };
      for (const [key, value] of entries) {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: value || null }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(err?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { value: string | null };
        next[key] = data.value;
      }
      setSaved(next);
      toast.success("已保存", { description: "下一次打标 / 起题即生效" });
    } catch (err) {
      toast.error("保存失败", {
        description: err instanceof Error ? err.message : "稍后重试",
      });
    } finally {
      setBusy(false);
    }
  };

  // Extract third-party models that can be used
  const claudeCompatibleFromCatalog = catalog.filter(
    (p) => !p.id.startsWith("codex") && p.id !== "mock",
  );
  const codexCompatibleFromCatalog = catalog.filter((p) => p.id.startsWith("codex"));

  return (
    <div className="rounded-card border border-line bg-surface p-4 flex flex-col gap-3">
      {loadError !== null && (
        <ErrorCallout error={loadError} title="打标 / 起题模型配置加载失败" compact />
      )}
      <div>
        <div className="text-ui font-medium text-ink-strong">打标 / 起题模型</div>
        <p className="text-label text-ink-muted mt-1 leading-relaxed">
          节点话题标签与会话自动命名共用的小模型，按会话所属的 CLI
          （Claude / Codex）分别设置。留空走默认；生成失败只会静默保持原标题，不影响对话。
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Claude 系 */}
        <div className="flex flex-col gap-2 p-3 rounded-card border border-line">
          <div className="flex items-center justify-between">
            <span className="text-ui font-medium text-ink-strong">
              Claude 系
            </span>
            <span className="text-nano font-mono text-ink-faint">
              claude -p --model
            </span>
          </div>

          <Input
            className="font-mono"
            value={claude}
            onChange={(e) => setClaude(e.target.value)}
            placeholder="默认 haiku"
            disabled={!loaded || busy}
          />

          {/* 快捷预设 Tags */}
          <div className="space-y-1 pt-1">
            <div className="text-nano text-ink-faint">快捷选择</div>
            <div className="flex flex-wrap gap-1">
              {CLAUDE_PRESETS.map((p) => {
                const isSelected = claude === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setClaude(p.value)}
                    disabled={!loaded || busy}
                    className={`px-2 py-0.5 text-nano rounded-md border transition-colors ${
                      isSelected
                        ? "bg-accent-muted text-accent-ink border-accent-line font-medium"
                        : "bg-surface text-ink-muted hover:text-ink hover:bg-surface-hover border-line"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 从已配置的 Provider 列表中选择 */}
          {claudeCompatibleFromCatalog.length > 0 && (
            <div className="pt-1">
              <div className="text-nano text-ink-faint mb-1">从已配端点选：</div>
              <Select
                size="sm"
                aria-label="选择已配置的 Claude 兼容模型"
                placeholder="选择已配置的 Claude 兼容模型"
                value={claudeCompatibleFromCatalog.some((p) => p.shortLabel === claude) ? claude : NONE}
                onValueChange={(v) => {
                  if (v !== NONE) setClaude(v);
                }}
                disabled={!loaded || busy}
                options={[
                  { value: NONE, label: "选择已配置的 Claude 兼容模型", disabled: true },
                  ...claudeCompatibleFromCatalog.map((p) => ({
                    value: p.shortLabel,
                    label: `${p.label} (${p.shortLabel})`,
                  })),
                ]}
              />
            </div>
          )}
        </div>

        {/* Codex 系 */}
        <div className="flex flex-col gap-2 p-3 rounded-card border border-line">
          <div className="flex items-center justify-between">
            <span className="text-ui font-medium text-ink-strong">
              Codex 系
            </span>
            <span className="text-nano font-mono text-ink-faint">
              codex -c model=
            </span>
          </div>

          <Input
            className="font-mono"
            value={codex}
            onChange={(e) => setCodex(e.target.value)}
            placeholder="默认用本机默认模型"
            disabled={!loaded || busy}
          />

          {/* 快捷预设 Tags */}
          <div className="space-y-1 pt-1">
            <div className="text-nano text-ink-faint">快捷选择</div>
            <div className="flex flex-wrap gap-1">
              {CODEX_PRESETS.map((p) => {
                const isSelected = codex === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setCodex(p.value)}
                    disabled={!loaded || busy}
                    className={`px-2 py-0.5 text-nano rounded-md border transition-colors ${
                      isSelected
                        ? "bg-accent-muted text-accent-ink border-accent-line font-medium"
                        : "bg-surface text-ink-muted hover:text-ink hover:bg-surface-hover border-line"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 从已配置的 Codex 列表中选择 */}
          {codexCompatibleFromCatalog.length > 0 && (
            <div className="pt-1">
              <div className="text-nano text-ink-faint mb-1">从已配端点选：</div>
              <Select
                size="sm"
                aria-label="选择已配置的 Codex 模型"
                placeholder="选择已配置的 Codex 模型"
                value={codexCompatibleFromCatalog.some((p) => p.shortLabel === codex) ? codex : NONE}
                onValueChange={(v) => {
                  if (v !== NONE) setCodex(v);
                }}
                disabled={!loaded || busy}
                options={[
                  { value: NONE, label: "选择已配置的 Codex 模型", disabled: true },
                  ...codexCompatibleFromCatalog.map((p) => ({
                    value: p.shortLabel,
                    label: `${p.label} (${p.shortLabel})`,
                  })),
                ]}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button variant="primary" onClick={save} disabled={!loaded || !dirty} loading={busy}>
          保存设置
        </Button>
      </div>
    </div>
  );
}
