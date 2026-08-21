"use client";
import { useEffect, useState } from "react";

// 打标 / 起题模型配置卡（settings/models tab，与 AuthHealthCard 同级）。
// 节点话题标签与会话自动命名共用一条 CLI spawn 管道（lib/llm/topic.ts），
// 模型默认 claude=haiku / codex=本机默认；只路由部分模型的网关环境（企业
// 网关、自建 cpa 类）在这里覆盖。存服务端 app_settings（spawn 在服务端，
// localStorage 够不着），空值 = 回默认。生成本身 best-effort：配错模型的
// 后果只是标题静默保持首问截断，不影响对话。
const FIELD =
  "w-full px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line";

type Settings = {
  label_model_claude: string | null;
  label_model_codex: string | null;
};

export function LabelModelCard() {
  const [loaded, setLoaded] = useState(false);
  const [claude, setClaude] = useState("");
  const [codex, setCodex] = useState("");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        const s = (data.settings ?? {}) as Settings;
        setClaude(s.label_model_claude ?? "");
        setCodex(s.label_model_codex ?? "");
        setSaved(s);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setNotice("加载失败，稍后重试");
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
    setNotice(null);
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
      setNotice("已保存 — 下一次打标/起题即生效");
    } catch (err) {
      setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-line bg-surface shadow-raise p-4 flex flex-col gap-3">
      <div>
        <div className="text-ui font-medium text-ink-strong">打标 / 起题模型</div>
        <p className="text-label text-ink-muted mt-1 leading-relaxed">
          节点话题标签与会话自动命名共用的小模型，按会话的 CLI
          家族路由。留空走默认；生成失败只会静默保持原标题，不影响对话。
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-label text-ink-muted">
            Claude 系（<code>claude -p --model</code> 的值）
          </span>
          <input
            className={FIELD}
            value={claude}
            onChange={(e) => setClaude(e.target.value)}
            placeholder="默认 haiku"
            disabled={!loaded || busy}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label text-ink-muted">
            Codex 系（<code>codex -c model=</code> 的值）
          </span>
          <input
            className={FIELD}
            value={codex}
            onChange={(e) => setCodex(e.target.value)}
            placeholder="默认用本机默认模型"
            disabled={!loaded || busy}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!loaded || busy || !dirty}
          className="px-3 py-1.5 rounded-field border border-accent-line bg-accent-muted text-accent-ink text-ui disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent-muted/70 transition-colors"
        >
          {busy ? "保存中…" : "保存"}
        </button>
        {notice && (
          <span className="text-label text-ink-muted">{notice}</span>
        )}
      </div>
    </div>
  );
}
