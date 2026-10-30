"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  toast,
  useConfirm,
} from "@/components/ui";
import { describeToolKey, type ApprovalRule } from "@/lib/approval-rules";
import { formatRelativeTime } from "@/lib/relative-time";

type RuleItem = ApprovalRule & { sessionTitle: string | null };

// 审批三档作用域的「已授权规则」：审批卡上选「本会话 / 所有会话始终允许」落下的规则。
// 全局规则只能在这里撤销；会话规则随会话删除自动失效，也列在这里方便提前撤销。
// 撤销立即生效（服务端每次发起审批前现查规则表）。
export default function ApprovalRulesPage() {
  const [rules, setRules] = useState<RuleItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback((): Promise<void> => {
    setError(null);
    return fetch("/api/approval-rules", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setRules((body as { rules: RuleItem[] }).rules);
      })
      .catch((cause: unknown) => setError(cause ?? new Error("规则列表加载失败")));
  }, []);

  useEffect(() => {
    // 延后一拍，让 load 内的状态更新发生在 effect 之外（项目既有 lint 约束）。
    void Promise.resolve().then(load);
  }, [load]);

  const revoke = async (rule: RuleItem) => {
    const ok = await confirm({
      title: `撤销「${describeToolKey(rule.toolKey)}」？`,
      description:
        rule.scope === "global"
          ? "撤销后，所有需审批的会话再调用这个工具都会重新弹卡。"
          : `撤销后，会话「${rule.sessionTitle ?? "未命名"}」再调用这个工具会重新弹卡。`,
      confirmLabel: "撤销",
      danger: true,
    });
    if (!ok) return;
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/approval-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setRules((cur) => cur?.filter((r) => r.id !== rule.id) ?? cur);
      toast.success("已撤销");
    } catch (cause) {
      toast.error(`撤销失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusyId(null);
    }
  };

  const globalRules = rules?.filter((r) => r.scope === "global") ?? [];
  const sessionRules = rules?.filter((r) => r.scope === "session") ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="已授权规则"
        count={rules?.length}
        countUnit="条"
        subtitle="审批卡上选「本会话 / 所有会话始终允许」后落下的规则；命中时工具调用不弹卡，调用行尾标「按规则允许」"
        actions={
          <IconButton label="刷新" onClick={() => void load()}>
            <Icon icon={RefreshCw} />
          </IconButton>
        }
      />

      {error !== null && <ErrorCallout error={error} title="规则列表加载失败" onRetry={() => void load()} />}

      {rules === null && error === null && (
        <div role="status" aria-label="加载中" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {rules && rules.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="还没有授权规则"
          description="在需审批的会话里，审批卡的「放行范围」选本会话或所有会话再允许，规则就会出现在这里。"
          className="rounded-card bg-surface-raised shadow-raise"
        />
      )}

      {rules && rules.length > 0 && (
        <>
          <RuleSection
            title="所有会话"
            hint="对每个需审批的会话生效，只能在这里撤销。"
            delay={0}
            rules={globalRules}
            busyId={busyId}
            onRevoke={revoke}
          />
          <RuleSection
            title="单个会话"
            hint="只对所属会话生效；会话删除时自动失效。"
            delay={60}
            rules={sessionRules}
            busyId={busyId}
            onRevoke={revoke}
          />
        </>
      )}
    </div>
  );
}

function RuleSection({
  title,
  hint,
  rules,
  busyId,
  onRevoke,
  delay = 0,
}: {
  title: string;
  hint: string;
  delay?: number;
  rules: RuleItem[];
  busyId: string | null;
  onRevoke: (rule: RuleItem) => void;
}) {
  return (
    <section aria-label={title} className="ui-enter-up" style={{ animationDelay: `${delay}ms` }}>
      <h2 className="text-ui font-semibold text-ink-strong mb-1">
        {title} <span className="font-normal text-ink-faint">· {rules.length}</span>
      </h2>
      <p className="text-label text-ink-muted mb-2">{hint}</p>
      {rules.length === 0 ? (
        <p className="text-label text-ink-faint">无</p>
      ) : (
        <ul className="overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-approval-rule={rule.id}
              className="flex min-h-[46px] items-center gap-3 px-3 py-2 text-label transition-colors duration-100 hover:bg-surface-hover max-md:flex-wrap"
            >
              <Badge className="shrink-0 font-mono text-[11.5px]">{rule.toolKey}</Badge>
              <span className="min-w-0 flex-1 text-ui font-medium text-ink">{describeToolKey(rule.toolKey)}</span>
              {rule.scope === "session" && (
                <a
                  href={rule.sessionId ? `/?session=${encodeURIComponent(rule.sessionId)}` : undefined}
                  className="max-w-56 truncate text-ink-muted underline-offset-2 hover:underline max-md:basis-full max-md:order-last"
                  title={rule.sessionTitle ?? undefined}
                >
                  会话：{rule.sessionTitle ?? "未命名"}
                </a>
              )}
              <span className="shrink-0 tabular-nums text-ink-muted">
                {rule.useCount > 0 && rule.lastUsedAt
                  ? `已自动允许 ${rule.useCount} 次 · 最近 ${formatRelativeTime(rule.lastUsedAt)}`
                  : `创建于 ${formatRelativeTime(rule.createdAt)} · 尚未命中`}
              </span>
              <Button
                size="sm"
                variant="secondary"
                data-approval-revoke
                loading={busyId === rule.id}
                disabled={busyId !== null}
                onClick={() => onRevoke(rule)}
              >
                撤销
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
