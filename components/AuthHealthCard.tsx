"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { ErrorCallout, Icon, IconButton, SkeletonText } from "@/components/ui";

// S95: CLI 授权状态卡（claude / codex），挂在设置「模型与服务商」tab 顶部。
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
  const summary = !h.installed
    ? "未找到"
    : h.loggedIn === true
      ? `已登录${h.method ? ` · ${h.method}` : ""}${h.subscription ? ` · ${h.subscription}` : ""}`
      : h.loggedIn === false
        ? "未登录"
        : "状态未知";
  // 状态图标：有错 = 红色警示圈；有预警 = 琥珀三角；正常 = 淡色对勾（稿子 02-models）。
  const status = h.errors.length ? (
    <Icon icon={CircleAlert} size="sm" className="text-danger" aria-label="有错误" />
  ) : h.warnings.length ? (
    <Icon icon={TriangleAlert} size="sm" className="text-warn" aria-label="有预警" />
  ) : (
    <Icon icon={Check} size="sm" className="text-ink-faint" aria-label="正常" />
  );
  return (
    <div className="py-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="inline-flex w-4 justify-center">{status}</span>
        <span className="text-ui font-semibold text-ink-strong">{name}</span>
        <span className="text-ui text-ink-muted min-w-0 truncate">{summary}</span>
        {h.account && <span className="text-label text-ink-muted ml-auto truncate">{h.account}</span>}
      </div>
      {h.installed && (
        <div className="text-label text-ink-muted flex flex-wrap gap-x-4 gap-y-0.5 pl-6.5">
          {h.refreshExpiresAt !== null && (
            <span>
              刷新凭证至 <span className="font-mono">{fmtTime(h.refreshExpiresAt)}</span>{" "}
              {fmtRemaining(h.refreshExpiresAt)}
            </span>
          )}
          {h.accessExpiresAt !== null && (
            <span>
              访问凭证至 <span className="font-mono">{fmtTime(h.accessExpiresAt)}</span>
            </span>
          )}
          {h.credentialUpdatedAt !== null && (
            <span>
              凭证更新于 <span className="font-mono">{fmtTime(h.credentialUpdatedAt)}</span>
            </span>
          )}
        </div>
      )}
      {h.errors.map((e) => (
        <div
          key={e}
          className="ml-6.5 flex items-start gap-2 px-3 py-2 rounded-card border border-danger-line bg-danger-muted text-danger-ink text-label"
        >
          <Icon icon={CircleAlert} size="sm" className="mt-px" />
          <span className="min-w-0">{e}</span>
        </div>
      ))}
      {h.warnings.map((w) => (
        <div
          key={w}
          className="ml-6.5 flex items-start gap-2 px-3 py-2 rounded-card border border-warn-line bg-warn-muted text-ink text-label"
        >
          <Icon icon={TriangleAlert} size="sm" className="mt-px text-warn" />
          <span className="min-w-0">{w}</span>
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
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-ui font-semibold text-ink-strong">CLI 登录状态</h2>
        <span className="text-label text-ink-muted min-w-0 truncate max-md:hidden">
          新会话用的就是这两份本机登录态；每小时检查一次，快过期会提醒
        </span>
        <IconButton
          label="重新探测"
          size="sm"
          className="ml-auto"
          onClick={() => void load(true)}
          disabled={busy}
        >
          <Icon icon={RefreshCw} size="sm" className={busy ? "animate-spin" : undefined} />
        </IconButton>
      </div>
      <div className="rounded-card border border-line bg-surface px-4">
        {failed && !data && (
          <div className="py-3">
            <ErrorCallout
              error={null}
              title="登录状态探测失败"
              hint="稍后点右上角重新探测；若一直失败，看服务端日志。"
              onRetry={() => void load(true)}
              compact
            />
          </div>
        )}
        {!data && !failed && <SkeletonText lines={4} className="py-4" />}
        {data && (
          <div className="flex flex-col divide-y divide-line-faint">
            <CliRow name="claude" h={data.claude} />
            <CliRow name="codex" h={data.codex} />
          </div>
        )}
        {data && failed && (
          <div className="pb-3 text-label text-danger-ink">重新探测失败，下面仍是上一次的结果。</div>
        )}
      </div>
      <p className="mt-1.5 text-label text-ink-faint">
        失效时在有图形界面的终端跑 <code className="font-mono">claude auth login</code> 修复。
      </p>
    </section>
  );
}
