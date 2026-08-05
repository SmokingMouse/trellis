"use client";
import { useCallback, useEffect, useState } from "react";

// S95: CLI 授权状态卡（claude / codex），挂在设置「模型与 Provider」tab 顶部。
// 动机：S90-S93 的 OAuth 故障挂了 6 天没人知道 —— 凭证时效此前在界面上无处可见。
// 数据来自 /api/auth-health（30s 服务端缓存；「重新探测」带 force=1）。
// 展示逻辑刻意薄：所有判断（分叉哨兵/过期阈值/文案）都在 lib/server/auth-health.ts，
// 这里只渲染 —— 预警（notify 推送）与本卡共用同一份判断，不会出现「卡片绿着、
// 手机却在报警」的分裂。

type CliAuthHealth = {
  installed: boolean;
  loggedIn: boolean | null;
  method: string | null;
  subscription: string | null;
  account: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  credentialUpdatedAt: number | null;
  warnings: string[];
  errors: string[];
};
type AuthHealth = { claude: CliAuthHealth; codex: CliAuthHealth; checkedAt: number };

function fmtTime(ms: number | null): string {
  if (ms === null) return "未知";
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtRemaining(ms: number | null): string {
  if (ms === null) return "";
  const left = ms - Date.now();
  if (left <= 0) return "（已过期）";
  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return `（剩 ${days} 天）`;
  return `（剩 ${Math.max(1, Math.floor(left / 3_600_000))} 小时）`;
}

function CliRow({ name, h }: { name: string; h: CliAuthHealth }) {
  const tone = h.errors.length ? "🔴" : h.warnings.length ? "🟡" : "🟢";
  const summary = !h.installed
    ? "未找到"
    : h.loggedIn === true
      ? `已登录${h.method ? ` · ${h.method}` : ""}${h.subscription ? ` · ${h.subscription}` : ""}`
      : h.loggedIn === false
        ? "未登录"
        : "状态未知";
  return (
    <div className="py-2.5 flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span aria-hidden>{tone}</span>
        <span className="text-ui font-medium">{name}</span>
        <span className="text-ui text-ink-muted">{summary}</span>
        {h.account && <span className="text-label text-ink-muted ml-auto">{h.account}</span>}
      </div>
      {h.installed && (
        <div className="text-label text-ink-muted flex flex-wrap gap-x-4 gap-y-0.5 pl-6">
          {h.refreshExpiresAt !== null && (
            <span>
              refresh token 至 {fmtTime(h.refreshExpiresAt)} {fmtRemaining(h.refreshExpiresAt)}
            </span>
          )}
          {h.accessExpiresAt !== null && <span>access token 至 {fmtTime(h.accessExpiresAt)}</span>}
          {h.credentialUpdatedAt !== null && <span>凭证更新于 {fmtTime(h.credentialUpdatedAt)}</span>}
        </div>
      )}
      {h.errors.map((e) => (
        <div
          key={e}
          className="ml-6 px-2 py-1 rounded bg-danger-muted border border-danger-line text-danger-ink text-label"
        >
          {e}
        </div>
      ))}
      {h.warnings.map((w) => (
        <div
          key={w}
          className="ml-6 px-2 py-1 rounded bg-surface-muted border border-line text-ink-muted text-label"
        >
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

export function AuthHealthCard() {
  const [data, setData] = useState<AuthHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/auth-health${force ? "?force=1" : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as AuthHealth);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // promise 包一层 —— 与 app/settings/prefs/page.tsx:24 同一个既定写法。
    void Promise.resolve().then(() => load(false));
  }, [load]);

  return (
    <section className="rounded-card border border-line bg-surface shadow-raise p-4">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-ui font-medium">CLI 授权状态</h2>
        <button
          onClick={() => void load(true)}
          disabled={busy}
          className="ml-auto px-2 py-0.5 rounded border border-line text-label text-ink-muted hover:bg-surface-muted disabled:opacity-50"
        >
          {busy ? "探测中…" : "重新探测"}
        </button>
      </div>
      <p className="text-label text-ink-muted mb-1">
        spawn 出的会话用的就是这两份本机登录态；到期/分叉会推送预警（每小时检查）。
        失效时在有图形界面的终端跑 <code className="font-mono">claude auth login</code> 修复。
      </p>
      {failed && (
        <div className="px-2 py-1 rounded bg-danger-muted border border-danger-line text-danger-ink text-label">
          探测接口请求失败，稍后重试
        </div>
      )}
      {!data && !failed && <div className="text-label text-ink-muted py-2">探测中…</div>}
      {data && (
        <div className="flex flex-col divide-y divide-line-faint">
          <CliRow name="claude" h={data.claude} />
          <CliRow name="codex" h={data.codex} />
        </div>
      )}
    </section>
  );
}
