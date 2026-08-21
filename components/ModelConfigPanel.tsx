"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/sessionStore";
import { PROVIDER_PRESETS, type ProviderPreset } from "@/lib/llm";

// 模型配置编辑器 —— endpoints.yaml 的图形入口（服务端 lib/server/model-config.ts）。
// key 只进 env_file + process.env，接口永不回显；保存即热生效（picker 立刻刷新）。
//
// S89：拆成 Panel（内容）+ Modal（外壳）两层。
// S112: 交互升级 —— 提供常用 Provider 预设模版一键填入、模型 Tag 交互增删与候选推荐、全局默认模型可视化设置。

type CfgProvider = {
  name: string;
  anthropic_url?: string;
  openai_url?: string;
  api_key_env: string;
  models: string[];
  hasKey: boolean;
  native: boolean;
};

type CfgState = {
  path: string;
  exists: boolean;
  envFile: string | null;
  defaultModel: string | null;
  providers: CfgProvider[];
};

type FormState = {
  name: string;
  anthropicUrl: string;
  openaiUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  modelsList: string[];
  modelsRawText: string;
  useRawText: boolean;
  newModelInput: string;
  selectedPresetId: string | null;
  /** edit 模式下锁定 name */
  isEdit: boolean;
  hadKey: boolean;
};

const FIELD =
  "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";

export function ModelConfigPanel({ onClose }: { onClose?: () => void }) {
  const fetchProviderCatalog = useSessionStore((s) => s.fetchProviderCatalog);
  const [state, setState] = useState<CfgState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/model-config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: CfgState) => alive && setState(s))
      .catch((e) => alive && setLoadError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const openAdd = (preset?: ProviderPreset) => {
    if (preset) {
      setForm({
        name: preset.name,
        anthropicUrl: preset.anthropic_url ?? "",
        openaiUrl: preset.openai_url ?? "",
        apiKey: "",
        apiKeyEnv: preset.api_key_env,
        modelsList: [...preset.defaultModels],
        modelsRawText: preset.defaultModels.join("\n"),
        useRawText: false,
        newModelInput: "",
        selectedPresetId: preset.id,
        isEdit: false,
        hadKey: false,
      });
    } else {
      setForm({
        name: "",
        anthropicUrl: "",
        openaiUrl: "",
        apiKey: "",
        apiKeyEnv: "",
        modelsList: [],
        modelsRawText: "",
        useRawText: false,
        newModelInput: "",
        selectedPresetId: null,
        isEdit: false,
        hadKey: false,
      });
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    if (!form) return;
    setForm({
      ...form,
      name: preset.name,
      anthropicUrl: preset.anthropic_url ?? "",
      openaiUrl: preset.openai_url ?? "",
      apiKeyEnv: preset.api_key_env,
      modelsList: [...preset.defaultModels],
      modelsRawText: preset.defaultModels.join("\n"),
      selectedPresetId: preset.id,
    });
  };

  const openEdit = (p: CfgProvider) => {
    const matchedPreset = PROVIDER_PRESETS.find(
      (pr) => pr.name.toLowerCase() === p.name.toLowerCase(),
    );
    setForm({
      name: p.name,
      anthropicUrl: p.anthropic_url ?? "",
      openaiUrl: p.openai_url ?? "",
      apiKey: "",
      apiKeyEnv: p.api_key_env,
      modelsList: [...p.models],
      modelsRawText: p.models.join("\n"),
      useRawText: false,
      newModelInput: "",
      selectedPresetId: matchedPreset?.id ?? null,
      isEdit: true,
      hadKey: p.hasKey && !p.native,
    });
  };

  const addModelChip = (modelName: string) => {
    if (!form) return;
    const trimmed = modelName.trim();
    if (!trimmed || form.modelsList.includes(trimmed)) return;
    const nextList = [...form.modelsList, trimmed];
    setForm({
      ...form,
      modelsList: nextList,
      modelsRawText: nextList.join("\n"),
      newModelInput: "",
    });
  };

  const removeModelChip = (modelName: string) => {
    if (!form) return;
    const nextList = form.modelsList.filter((m) => m !== modelName);
    setForm({
      ...form,
      modelsList: nextList,
      modelsRawText: nextList.join("\n"),
    });
  };

  const handleRawTextChange = (text: string) => {
    if (!form) return;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    setForm({
      ...form,
      modelsRawText: text,
      modelsList: lines,
    });
  };

  const save = async () => {
    if (!form || busy) return;
    const models = form.useRawText
      ? form.modelsRawText.split("\n").map((m) => m.trim()).filter(Boolean)
      : form.modelsList.map((m) => m.trim()).filter(Boolean);

    if (models.length === 0) {
      setFormError("请至少配置一个模型");
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          anthropic_url: form.anthropicUrl || undefined,
          openai_url: form.openaiUrl || undefined,
          api_key_env: form.apiKeyEnv || undefined,
          apiKey: form.apiKey || undefined,
          models,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setState(body as CfgState);
      setForm(null);
      void fetchProviderCatalog();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (busy) return;
    if (!window.confirm(`删除 provider「${name}」？（env 文件里的 key 会保留）`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/model-config?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setState(body as CfgState);
      void fetchProviderCatalog();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateDefaultModel = async (model: string) => {
    if (settingDefault || !model) return;
    setSettingDefault(true);
    try {
      const res = await fetch("/api/model-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: model }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setState(body as CfgState);
      void fetchProviderCatalog();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingDefault(false);
    }
  };

  // Get suggested models for the current form provider
  const currentPreset = form
    ? PROVIDER_PRESETS.find(
        (p) =>
          p.id === form.selectedPresetId ||
          p.name.toLowerCase() === form.name.toLowerCase(),
      )
    : null;

  const unaddedSuggestions = currentPreset
    ? currentPreset.suggestedModels.filter((m) => !form?.modelsList.includes(m))
    : [];

  // All available models across configured providers (for default model selection)
  const allConfiguredModels = state
    ? state.providers.flatMap((p) =>
        p.models.map((m) => ({
          provider: p.name,
          model: m,
          id: p.name === "claude" ? m : `${p.name}:${m}`,
        })),
      )
    : [];

  return (
    <>
      <div className="px-5 pt-4 pb-3 border-b border-line shrink-0 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-ink-strong">模型与 Provider 配置</div>
          <div className="text-label text-ink-faint mt-0.5 truncate">
            {state ? (
              <>
                {state.exists ? "编辑" : "将创建"} {state.path}
                {state.envFile ? ` · key 存 ${state.envFile}` : ""}
              </>
            ) : (
              "加载中…"
            )}
          </div>
        </div>
        {state?.defaultModel && (
          <div className="text-label text-ink-muted bg-surface-muted px-2.5 py-1 rounded-field border border-line flex items-center gap-1.5">
            <span className="text-accent-ink">★</span>
            <span>默认模型：</span>
            <span className="font-mono text-ink-strong">{state.defaultModel}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loadError && (
          <div className="text-ui text-danger mb-3">加载失败：{loadError}</div>
        )}

        {form ? (
          <div className="space-y-4">
            {/* 新建模式下的预设厂商选择 */}
            {!form.isEdit && (
              <div className="rounded-lg border border-line bg-surface-muted/40 p-3">
                <div className="text-label font-medium text-ink-strong mb-2 flex items-center gap-1.5">
                  <span>⚡</span>
                  <span>常用厂商预设模版（点击一键填入）</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PROVIDER_PRESETS.map((preset) => {
                    const isSelected = form.selectedPresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className={`px-2.5 py-1 text-label rounded-md border transition-colors ${
                          isSelected
                            ? "bg-accent-muted text-accent-ink border-accent-line font-medium shadow-sm"
                            : "bg-surface text-ink hover:bg-surface-muted border-line"
                        }`}
                      >
                        {preset.badge}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-label text-ink-muted block mb-1">
                  provider 名 <span className="text-danger">*</span>
                </label>
                <input
                  className={FIELD}
                  value={form.name}
                  disabled={form.isEdit}
                  placeholder="deepseek / kimi / qwen"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-label text-ink-muted block mb-1">
                  key 环境变量名（留空自动生成）
                </label>
                <input
                  className={FIELD}
                  value={form.apiKeyEnv}
                  placeholder="DEEPSEEK_API_KEY"
                  onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label className="text-label text-ink-muted block mb-1">
                anthropic_url（走 claude CLI 必填；Anthropic 兼容端点）
              </label>
              <input
                className={FIELD}
                value={form.anthropicUrl}
                placeholder="https://api.deepseek.com/anthropic"
                onChange={(e) => setForm({ ...form, anthropicUrl: e.target.value })}
              />
            </div>

            <div>
              <label className="text-label text-ink-muted block mb-1">
                openai_url（可选；仅 openai_url 的端点走 Responses API）
              </label>
              <input
                className={FIELD}
                value={form.openaiUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setForm({ ...form, openaiUrl: e.target.value })}
              />
            </div>

            <div>
              <label className="text-label text-ink-muted block mb-1">
                API Key {form.hadKey ? "（已配置，留空 = 保持不变）" : "（将加密存入 env 文件）"}
              </label>
              <input
                className={FIELD}
                type="password"
                value={form.apiKey}
                autoComplete="off"
                placeholder={form.hadKey ? "••••••••" : "sk-…"}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </div>

            {/* 模型列表管理 */}
            <div className="rounded-lg border border-line bg-surface p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-label font-medium text-ink-strong">
                  模型列表 ({form.modelsList.length}) <span className="text-danger">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, useRawText: !form.useRawText })}
                  className="text-label text-ink-muted hover:text-ink underline"
                >
                  {form.useRawText ? "切换为标签编辑" : "切换为多行文本"}
                </button>
              </div>

              {form.useRawText ? (
                <div>
                  <textarea
                    className={`${FIELD} resize-none h-28 font-mono text-ui`}
                    value={form.modelsRawText}
                    placeholder={"deepseek-chat\ndeepseek-reasoner"}
                    onChange={(e) => handleRawTextChange(e.target.value)}
                  />
                  <div className="text-nano text-ink-faint mt-1">一行输入一个模型名称</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* 已添加的模型 Tag 列表 */}
                  <div className="flex flex-wrap gap-1.5 min-h-[2.5rem] p-2 rounded-field border border-line bg-surface-muted">
                    {form.modelsList.length === 0 ? (
                      <span className="text-label text-ink-faint self-center">
                        暂无模型，请在下方添加或点击推荐模版
                      </span>
                    ) : (
                      form.modelsList.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface border border-line text-ui font-mono text-ink-strong shadow-xs"
                        >
                          <span>{m}</span>
                          <button
                            type="button"
                            onClick={() => removeModelChip(m)}
                            className="text-ink-faint hover:text-danger ml-0.5"
                            title="移除此模型"
                          >
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </div>

                  {/* 快速添加模型输入框 */}
                  <div className="flex gap-1.5">
                    <input
                      className={`${FIELD} font-mono`}
                      value={form.newModelInput}
                      placeholder="输入新模型名，回车或点击添加"
                      onChange={(e) => setForm({ ...form, newModelInput: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModelChip(form.newModelInput);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => addModelChip(form.newModelInput)}
                      disabled={!form.newModelInput.trim()}
                    >
                      + 添加
                    </Button>
                  </div>

                  {/* 预设推荐候选模型 */}
                  {unaddedSuggestions.length > 0 && (
                    <div className="pt-1">
                      <div className="text-nano text-ink-faint mb-1.5">推荐候选模型（点击快速加入）：</div>
                      <div className="flex flex-wrap gap-1">
                        {unaddedSuggestions.map((sug) => (
                          <button
                            key={sug}
                            type="button"
                            onClick={() => addModelChip(sug)}
                            className="px-2 py-0.5 text-nano rounded-md border border-line-faint bg-surface hover:bg-surface-muted hover:border-line text-ink-muted hover:text-ink font-mono transition-colors"
                          >
                            + {sug}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {formError && <div className="text-ui text-danger">{formError}</div>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setForm(null)} disabled={busy}>
                取消
              </Button>
              <Button variant="primary" onClick={save} loading={busy}>
                保存配置
              </Button>
            </div>
          </div>
        ) : (
          <>
            {state && state.providers.length === 0 && (
              <div className="text-ui text-ink-muted mb-4 p-4 rounded-lg border border-line bg-surface-muted/30">
                还没有配置文件 —— 原生 claude / codex 走 CLI 登录态即可用；要接入第三方
                大模型端点（DeepSeek / Kimi / 通义千问 / 火山引擎等），请点击下方「添加 Provider」或快速从模版创建。
              </div>
            )}

            <div className="space-y-3">
              {state?.providers.map((p) => (
                <div
                  key={p.name}
                  className="border border-line rounded-card p-3.5 bg-surface flex flex-col sm:flex-row sm:items-start gap-3 justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-ui font-semibold text-ink-strong">{p.name}</span>
                      {p.native ? (
                        <span className="text-nano text-ink-faint border border-line rounded-full px-2 py-0.5">
                          原生 CLI · 免 key
                        </span>
                      ) : p.hasKey ? (
                        <span className="text-nano text-positive font-medium bg-positive/10 border border-positive/30 rounded-full px-2 py-0.5">
                          ✓ Key 已配置
                        </span>
                      ) : (
                        <span className="text-nano text-danger font-medium bg-danger/10 border border-danger/30 rounded-full px-2 py-0.5">
                          缺 Key ({p.api_key_env})
                        </span>
                      )}
                    </div>

                    {(p.anthropic_url || p.openai_url) && (
                      <div className="text-label font-mono text-ink-faint truncate mt-1">
                        {p.anthropic_url ?? p.openai_url}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {p.models.map((m) => {
                        const isDefault = state.defaultModel === m || state.defaultModel === `${p.name}:${m}`;
                        return (
                          <span
                            key={m}
                            className={`text-nano font-mono px-2 py-0.5 rounded-md border flex items-center gap-1 ${
                              isDefault
                                ? "bg-accent-muted text-accent-ink border-accent-line font-medium"
                                : "bg-surface-muted text-ink-strong border-line"
                            }`}
                          >
                            {isDefault && <span>★</span>}
                            <span>{m}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex gap-1.5 shrink-0 self-end sm:self-start">
                    {/* 设为默认模型快速操作 */}
                    {p.models.length > 0 && !p.models.some((m) => state.defaultModel === m || state.defaultModel === `${p.name}:${m}`) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updateDefaultModel(p.models[0])}
                        disabled={settingDefault}
                        title={`将 ${p.models[0]} 设为全局默认模型`}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                      编辑
                    </Button>
                    {!p.native && (
                      <Button size="sm" variant="ghost" onClick={() => remove(p.name)}>
                        删除
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {!form && (
        <div className="px-5 py-3 border-t border-line flex flex-col sm:flex-row items-center justify-between gap-2 shrink-0 bg-surface">
          <div className="text-label text-ink-faint">
            改动即时生效，其他 sm-toolkit 工具共用同一份 endpoints.yaml
          </div>
          <div className="flex gap-2">
            {onClose && (
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
            )}
            <Button variant="primary" onClick={() => openAdd()} disabled={!state && !loadError}>
              + 添加 Provider
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Modal 外壳。给 ModelPicker 下拉底部那个入口用。
 */
export function ModelConfigModal({ onClose }: { onClose: () => void }) {
  return createPortal(
    <Modal onClose={onClose} size="lg" panelClassName="max-h-[85vh] flex flex-col">
      <ModelConfigPanel onClose={onClose} />
    </Modal>,
    document.body,
  );
}
