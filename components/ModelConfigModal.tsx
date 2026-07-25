"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/sessionStore";

// 模型配置编辑器 —— endpoints.yaml 的图形入口（服务端 lib/server/model-config.ts）。
// key 只进 env_file + process.env，接口永不回显；保存即热生效（picker 立刻刷新）。

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
  modelsText: string;
  /** edit 模式下锁定 name（改名 = 删旧加新，语义太隐晦不做） */
  isEdit: boolean;
  hadKey: boolean;
};

const FIELD =
  "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";

export function ModelConfigModal({ onClose }: { onClose: () => void }) {
  const fetchProviderCatalog = useSessionStore((s) => s.fetchProviderCatalog);
  const [state, setState] = useState<CfgState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const openAdd = () =>
    setForm({
      name: "",
      anthropicUrl: "",
      openaiUrl: "",
      apiKey: "",
      apiKeyEnv: "",
      modelsText: "",
      isEdit: false,
      hadKey: false,
    });

  const openEdit = (p: CfgProvider) =>
    setForm({
      name: p.name,
      anthropicUrl: p.anthropic_url ?? "",
      openaiUrl: p.openai_url ?? "",
      apiKey: "",
      apiKeyEnv: p.api_key_env,
      modelsText: p.models.join("\n"),
      isEdit: true,
      hadKey: p.hasKey && !p.native,
    });

  const save = async () => {
    if (!form || busy) return;
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
          models: form.modelsText.split("\n").map((m) => m.trim()).filter(Boolean),
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

  // Portal to body: the picker lives inside the Header, whose backdrop-blur
  // makes it the containing block for fixed descendants — an in-place Modal
  // (fixed inset-0) would be trapped inside the 48px header strip.
  return createPortal(
    <Modal onClose={onClose} size="lg" panelClassName="max-h-[80vh] flex flex-col">
      <div className="px-5 pt-4 pb-3 border-b border-line shrink-0">
        <div className="text-sm font-medium text-ink-strong">模型配置</div>
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

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loadError && (
          <div className="text-ui text-danger mb-3">加载失败：{loadError}</div>
        )}

        {form ? (
          <div className="space-y-3">
            <div>
              <label className="text-label text-ink-muted block mb-1">provider 名</label>
              <input
                className={FIELD}
                value={form.name}
                disabled={form.isEdit}
                placeholder="deepseek"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
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
                openai_url（可选；仅 openai_url 的 provider 不会出现在对话模型列表）
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
                API key{form.hadKey ? "（已配置，留空 = 不改）" : ""}
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
            <div>
              <label className="text-label text-ink-muted block mb-1">
                key 环境变量名（留空自动 = 大写 provider 名 + _API_KEY）
              </label>
              <input
                className={FIELD}
                value={form.apiKeyEnv}
                placeholder="DEEPSEEK_API_KEY"
                onChange={(e) => setForm({ ...form, apiKeyEnv: e.target.value })}
              />
            </div>
            <div>
              <label className="text-label text-ink-muted block mb-1">模型（一行一个）</label>
              <textarea
                className={`${FIELD} resize-none h-24`}
                value={form.modelsText}
                placeholder={"deepseek-v4-flash\ndeepseek-v4-pro"}
                onChange={(e) => setForm({ ...form, modelsText: e.target.value })}
              />
            </div>
            {formError && <div className="text-ui text-danger">{formError}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setForm(null)} disabled={busy}>
                取消
              </Button>
              <Button variant="primary" onClick={save} loading={busy}>
                保存
              </Button>
            </div>
          </div>
        ) : (
          <>
            {state && state.providers.length === 0 && (
              <div className="text-ui text-ink-muted mb-3">
                还没有配置文件——原生 claude / codex 走 CLI 登录态即可用；要接第三方
                Anthropic 兼容端点（deepseek / kimi / ark …）点下面「添加 provider」。
              </div>
            )}
            <div className="space-y-2">
              {state?.providers.map((p) => (
                <div
                  key={p.name}
                  className="border border-line rounded-card px-3 py-2.5 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-ui font-medium text-ink-strong">{p.name}</span>
                      {p.native ? (
                        <span className="text-nano text-ink-faint border border-line rounded-full px-1.5">
                          原生 CLI · 免 key
                        </span>
                      ) : p.hasKey ? (
                        <span className="text-nano text-positive">✓ key 已配</span>
                      ) : (
                        <span className="text-nano text-danger">缺 key（{p.api_key_env}）</span>
                      )}
                    </div>
                    {(p.anthropic_url || p.openai_url) && (
                      <div className="text-label text-ink-faint truncate mt-0.5">
                        {p.anthropic_url ?? p.openai_url}
                      </div>
                    )}
                    <div className="text-label text-ink-muted mt-1 break-words">
                      {p.models.join(" · ")}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(p.name)}>
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {!form && (
        <div className="px-5 py-3 border-t border-line flex items-center justify-between shrink-0">
          <div className="text-label text-ink-faint">
            改动即时生效，其他 sm-toolkit 工具共用同一份配置
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Button variant="primary" onClick={openAdd} disabled={!state && !loadError}>
              添加 provider
            </Button>
          </div>
        </div>
      )}
    </Modal>,
    document.body,
  );
}
