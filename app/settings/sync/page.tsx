"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ArrowRight, FolderSync, KeyRound, RefreshCw, ShieldOff, TriangleAlert, Unplug } from "lucide-react";
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  cn,
  toast,
  useConfirm,
  type BadgeVariant,
} from "@/components/ui";
import { fetchNodes, viaFetch } from "@/lib/gw-client";
import type { GwNode } from "@/lib/gw-types";
import {
  CONFIG_KINDS,
  CONFIG_KIND_META,
  OUTCOME_LABEL,
  STATUS_LABEL,
  itemId,
  type ConfigDiffItem,
  type ConfigKind,
  type ConfigPackage,
  type DiffStatus,
  type ImportOutcome,
  type ImportResultItem,
  type ImportSelection,
} from "@/lib/config-sync";

// 配置同步（P4）：经 hub 把技能 / Agent / 审批规则 / 模型配置从一台机器选择性搬到另一台。
//
// 全程在浏览器里经 /__gw/via 一读一写，hub 不落任何配置：
//   ① 来源 GET /api/export/config?skillContent=0（技能只要清单 + 哈希，预览不搬内容）
//   ② 目标 POST /api/import/config { dryRun: true } → 逐项差异
//   ③ 用户勾选（新增默认勾、冲突默认跳过）→ 有技能被选中时再向来源取一次带内容的包
//   ④ 目标 POST /api/import/config { items } → 结果汇总
// 来源机器没开「允许内容离开」时网关对 /api/export/* 回 403，这里提前按策略拦下并说明。
// 密钥一律不同步：导出端剔除 / 打码，目标保留自己的，缺的在结果里列出来让用户补。

type Choice = { checked: boolean; overwrite: boolean };

const STATUS_VARIANT: Record<DiffStatus, BadgeVariant> = {
  new: "positive",
  conflict: "warn",
  same: "neutral",
  blocked: "danger",
};

const OUTCOME_VARIANT: Record<ImportOutcome, BadgeVariant> = {
  created: "positive",
  overwritten: "accent",
  skipped: "neutral",
  unchanged: "neutral",
  failed: "danger",
};

function isGatewayAbsent(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
  return body as T;
}

function exportPath(kinds: ConfigKind[], opts: { skills?: string[]; content: boolean }): string {
  const q = new URLSearchParams({ kinds: kinds.join(","), skillContent: opts.content ? "1" : "0" });
  if (opts.skills) q.set("skills", opts.skills.join(","));
  return `/api/export/config?${q.toString()}`;
}

function defaultChoice(item: ConfigDiffItem): Choice {
  return { checked: item.status === "new", overwrite: false };
}

export default function ConfigSyncPage() {
  const [nodes, setNodes] = useState<GwNode[] | null>(null);
  const [gwError, setGwError] = useState<unknown>(null);
  const [source, setSource] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [kinds, setKinds] = useState<Set<ConfigKind>>(() => new Set(CONFIG_KINDS));
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pkg, setPkg] = useState<ConfigPackage | null>(null);
  const [diff, setDiff] = useState<ConfigDiffItem[] | null>(null);
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [results, setResults] = useState<ImportResultItem[] | null>(null);
  const confirm = useConfirm();

  const load = useCallback((): Promise<void> => {
    return fetchNodes()
      .then((list) => {
        setNodes(list);
        setGwError(null);
        // 默认：来源 = 当前所在机器，目标 = 第一台别的在线机器
        setSource((cur) => cur || list.find((n) => n.current)?.name || list[0]?.name || "");
        setTarget((cur) => cur || list.find((n) => !n.current && n.online)?.name || "");
      })
      .catch((err: unknown) => setGwError(err ?? new Error("网关不可达")));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const resetPreview = () => {
    setPkg(null);
    setDiff(null);
    setResults(null);
    setError(null);
  };

  const sourceNode = nodes?.find((n) => n.name === source);
  const targetNode = nodes?.find((n) => n.name === target);
  const shareOutBlocked = sourceNode ? !sourceNode.policy.shareOut : false;
  const canPreview =
    !!sourceNode && !!targetNode && source !== target && sourceNode.online && targetNode.online && !shareOutBlocked && kinds.size > 0;

  const nodeOptions = (nodes ?? []).map((n) => ({
    value: n.name,
    label: n.name,
    description: [n.kind === "home" ? "本机实例" : "远端机器", n.current ? "当前" : null, n.online ? null : "离线"]
      .filter(Boolean)
      .join(" · "),
    disabled: !n.online,
  }));

  const preview = async () => {
    if (!canPreview) return;
    setBusy("preview");
    resetPreview();
    try {
      const kindList = CONFIG_KINDS.filter((k) => kinds.has(k));
      const exported = await readJson<ConfigPackage>(await viaFetch(source, exportPath(kindList, { content: false })));
      const { items } = await readJson<{ items: ConfigDiffItem[] }>(
        await viaFetch(target, "/api/import/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: exported, dryRun: true }),
        }),
      );
      setPkg(exported);
      setDiff(items);
      setChoices(new Map(items.map((i) => [itemId(i.kind, i.key), defaultChoice(i)])));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const choiceOf = (item: ConfigDiffItem) => choices.get(itemId(item.kind, item.key)) ?? defaultChoice(item);
  const setChoice = (item: ConfigDiffItem, patch: Partial<Choice>) =>
    setChoices((cur) => {
      const next = new Map(cur);
      const id = itemId(item.kind, item.key);
      next.set(id, { ...(cur.get(id) ?? defaultChoice(item)), ...patch });
      return next;
    });

  /** 会真正写到目标上的项：勾选的新增 + 选了覆盖的冲突。 */
  const toWrite = useMemo(
    () =>
      (diff ?? []).filter((i) => {
        const c = choices.get(itemId(i.kind, i.key));
        return (i.status === "new" && c?.checked) || (i.status === "conflict" && c?.overwrite);
      }),
    [diff, choices],
  );

  const apply = async () => {
    if (!pkg || !diff || toWrite.length === 0) return;
    const overwriteCount = toWrite.filter((i) => i.status === "conflict").length;
    const ok = await confirm({
      title: `把 ${toWrite.length} 项写到「${target}」？`,
      description:
        overwriteCount > 0
          ? `其中 ${overwriteCount} 项会覆盖目标机器上的同名配置（目标自己的密钥会保留）。覆盖不可撤销。`
          : "只新增目标机器上没有的配置，不改动已有的。",
      confirmLabel: overwriteCount > 0 ? "覆盖并应用" : "应用",
      danger: overwriteCount > 0,
    });
    if (!ok) return;
    setBusy("apply");
    setError(null);
    try {
      // 选中的技能这时才去来源取内容；没选中的技能不随包发出去。
      const skillNames = toWrite.filter((i) => i.kind === "skills").map((i) => i.key);
      let full: ConfigPackage = { ...pkg, skills: [] };
      if (skillNames.length) {
        const withContent = await readJson<ConfigPackage>(
          await viaFetch(source, exportPath(["skills"], { skills: skillNames, content: true })),
        );
        full = { ...pkg, skills: withContent.skills ?? [] };
      }
      const items: ImportSelection[] = diff
        .filter((i) => i.status !== "blocked")
        .map((i) => {
          const c = choiceOf(i);
          if (i.status === "conflict") return { kind: i.kind, key: i.key, overwrite: c.overwrite };
          if (i.status === "new" && !c.checked) return null;
          return { kind: i.kind, key: i.key };
        })
        .filter((s): s is ImportSelection => s !== null);
      const res = await readJson<{ results: ImportResultItem[] }>(
        await viaFetch(target, "/api/import/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: full, dryRun: false, items }),
        }),
      );
      setResults(res.results);
      const failed = res.results.filter((r) => r.outcome === "failed").length;
      if (failed) toast.error(`${failed} 项失败，详见结果`);
      else toast.success("同步完成");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const gatewayAbsent = gwError !== null && isGatewayAbsent(gwError);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="配置同步"
        subtitle="把技能、Agent、审批规则、模型配置从一台机器选择性搬到另一台：单向、手动、先预览再应用；API Key 等密钥不同步"
        actions={
          <IconButton label="刷新机器列表" onClick={() => void load()}>
            <Icon icon={RefreshCw} />
          </IconButton>
        }
      />

      {gatewayAbsent && (
        <EmptyState
          icon={Unplug}
          title="当前不是经 hub 访问"
          description="配置同步要经 hub 同时连上两台机器。请从 hub 地址打开 Trellis；还没接入的机器在「机器互联」里添加。"
          action={
            <Link href="/settings/nodes" className={buttonVariants({ variant: "secondary" })}>
              去机器互联
            </Link>
          }
          className="rounded-card bg-surface-raised shadow-raise"
        />
      )}

      {gwError !== null && !gatewayAbsent && (
        <ErrorCallout error={gwError} title="连不上 hub" hint="确认是经 hub 地址访问的、且网关在运行。" onRetry={() => void load()} />
      )}

      {gwError === null && !nodes && (
        <div role="status" aria-label="加载中" className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {nodes && nodes.length < 2 && (
        <EmptyState
          icon={FolderSync}
          title="至少需要两台机器"
          description="hub 上目前只有这一台机器。在「机器互联」里接入另一台后，就能在两台之间同步配置。"
          action={
            <Link href="/settings/nodes" className={buttonVariants({ variant: "secondary" })}>
              去机器互联
            </Link>
          }
          className="rounded-card bg-surface-raised shadow-raise"
        />
      )}

      {nodes && nodes.length >= 2 && (
        <>
          <section aria-label="来源与目标" className="ui-enter-up rounded-card bg-surface-raised p-4 shadow-raise">
            <div className="flex items-end gap-2 max-md:flex-col max-md:items-stretch">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-label text-ink-muted">来源机器（从这里读）</span>
                <Select
                  aria-label="来源机器"
                  value={source || undefined}
                  placeholder="选择来源"
                  options={nodeOptions}
                  onValueChange={(v) => {
                    setSource(v);
                    resetPreview();
                  }}
                />
              </label>
              <IconButton
                label="交换来源与目标"
                className="max-md:self-center"
                onClick={() => {
                  setSource(target);
                  setTarget(source);
                  resetPreview();
                }}
              >
                <Icon icon={ArrowLeftRight} />
              </IconButton>
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-label text-ink-muted">目标机器（写到这里）</span>
                <Select
                  aria-label="目标机器"
                  value={target || undefined}
                  placeholder="选择目标"
                  options={nodeOptions}
                  onValueChange={(v) => {
                    setTarget(v);
                    resetPreview();
                  }}
                />
              </label>
            </div>

            {source && source === target && (
              <p className="mt-2 text-label text-warn-ink">来源和目标是同一台机器</p>
            )}

            {shareOutBlocked && (
              <div className="mt-3 flex items-start gap-2.5 rounded-card border border-warn-line bg-warn-muted px-3.5 py-3 text-ui text-warn-ink">
                <Icon icon={ShieldOff} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  「{source}」没有允许内容离开这台机器，导出接口会被 hub 拒绝（远端机器默认关闭，免得公司机器上的东西默认流回别处）。
                  需要的话在{" "}
                  <Link href="/settings/nodes" className="font-medium underline underline-offset-2">
                    机器互联
                  </Link>{" "}
                  里打开它的「允许内容离开这台机器」。
                </div>
              </div>
            )}

            <fieldset className="mt-4">
              <legend className="mb-2 text-label text-ink-muted">同步哪些类别</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {CONFIG_KINDS.map((k) => (
                  <label
                    key={k}
                    className="flex cursor-pointer items-start gap-2.5 rounded-field px-2 py-1.5 transition-colors duration-100 hover:bg-surface-hover"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={kinds.has(k)}
                      onCheckedChange={(v) => {
                        setKinds((cur) => {
                          const next = new Set(cur);
                          if (v === true) next.add(k);
                          else next.delete(k);
                          return next;
                        });
                        resetPreview();
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-ui font-medium text-ink">{CONFIG_KIND_META[k].label}</span>
                      <span className="block text-label text-ink-faint">{CONFIG_KIND_META[k].hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="primary" onClick={() => void preview()} disabled={!canPreview || busy !== null} loading={busy === "preview"}>
                预览差异
                <Icon icon={ArrowRight} />
              </Button>
            </div>
          </section>

          {error !== null && <ErrorCallout error={error} title={busy === "apply" || diff ? "应用失败" : "预览失败"} onRetry={() => void (diff ? apply() : preview())} />}

          {diff && !results && (
            <PreviewList
              diff={diff}
              kinds={CONFIG_KINDS.filter((k) => kinds.has(k))}
              choiceOf={choiceOf}
              setChoice={setChoice}
              toWriteCount={toWrite.length}
              applying={busy === "apply"}
              onApply={() => void apply()}
              target={target}
            />
          )}

          {results && <ResultSummary results={results} source={source} target={target} onAgain={() => void preview()} />}
        </>
      )}
    </div>
  );
}

function PreviewList({
  diff,
  kinds,
  choiceOf,
  setChoice,
  toWriteCount,
  applying,
  onApply,
  target,
}: {
  diff: ConfigDiffItem[];
  kinds: ConfigKind[];
  choiceOf: (item: ConfigDiffItem) => Choice;
  setChoice: (item: ConfigDiffItem, patch: Partial<Choice>) => void;
  toWriteCount: number;
  applying: boolean;
  onApply: () => void;
  target: string;
}) {
  const counts = (status: DiffStatus) => diff.filter((i) => i.status === status).length;
  return (
    <section aria-label="差异预览" className="ui-enter-up flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-label text-ink-muted">
        <span className="text-ui font-semibold text-ink-strong">差异预览</span>
        {(["new", "conflict", "same", "blocked"] as const).map((s) => (
          <Badge key={s} variant={STATUS_VARIANT[s]}>
            {STATUS_LABEL[s]} {counts(s)}
          </Badge>
        ))}
      </div>

      {diff.length === 0 && (
        <EmptyState icon={FolderSync} title="来源机器上没有可同步的配置" className="rounded-card bg-surface-raised shadow-raise" />
      )}

      {kinds.map((kind) => {
        const items = diff.filter((i) => i.kind === kind);
        if (!items.length) return null;
        const fresh = items.filter((i) => i.status === "new");
        const allFresh = fresh.length > 0 && fresh.every((i) => choiceOf(i).checked);
        const someFresh = fresh.some((i) => choiceOf(i).checked);
        return (
          <div key={kind}>
            <div className="mb-1.5 flex items-center gap-2">
              {fresh.length > 0 && (
                <Checkbox
                  aria-label={`全选「${CONFIG_KIND_META[kind].label}」的新增项`}
                  checked={allFresh ? true : someFresh ? "indeterminate" : false}
                  onCheckedChange={(v) => fresh.forEach((i) => setChoice(i, { checked: v === true }))}
                />
              )}
              <h3 className="text-ui font-semibold text-ink-strong">
                {CONFIG_KIND_META[kind].label} <span className="font-normal text-ink-faint">· {items.length}</span>
              </h3>
            </div>
            <ul className="overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line">
              {items.map((item) => (
                <DiffRow key={item.key} item={item} choice={choiceOf(item)} onChange={(p) => setChoice(item, p)} />
              ))}
            </ul>
          </div>
        );
      })}

      {diff.length > 0 && (
        <div className="sticky bottom-0 flex items-center justify-end gap-3 rounded-card bg-surface-raised px-4 py-3 shadow-raise">
          <span className="text-label text-ink-muted">
            {toWriteCount > 0 ? `将写入「${target}」${toWriteCount} 项` : "没有选中要写入的项"}
          </span>
          <Button variant="primary" onClick={onApply} disabled={toWriteCount === 0 || applying} loading={applying}>
            应用
          </Button>
        </div>
      )}
    </section>
  );
}

function DiffRow({ item, choice, onChange }: { item: ConfigDiffItem; choice: Choice; onChange: (p: Partial<Choice>) => void }) {
  const inert = item.status === "same" || item.status === "blocked";
  return (
    <li
      data-sync-item={`${item.kind}:${item.key}`}
      className={cn(
        "flex min-h-[46px] items-start gap-3 px-3 py-2.5 text-label transition-colors duration-100 hover:bg-surface-hover max-md:flex-wrap",
        inert && "opacity-70",
      )}
    >
      <span className="mt-0.5 flex w-4 shrink-0 justify-center">
        {item.status === "new" && (
          <Checkbox aria-label={`同步 ${item.label}`} checked={choice.checked} onCheckedChange={(v) => onChange({ checked: v === true })} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui font-medium text-ink">{item.label}</span>
          <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
        </div>
        {item.summary && <p className="mt-0.5 truncate text-ink-muted" title={item.summary}>{item.summary}</p>}
        {item.changes && item.changes.length > 0 && <p className="mt-0.5 text-ink-muted">不同：{item.changes.join("、")}</p>}
        {item.reason && <p className="mt-0.5 text-danger-ink">{item.reason}</p>}
        {item.warnings.map((w) => (
          <p key={w} className="mt-0.5 flex items-start gap-1.5 text-warn-ink">
            <Icon icon={w.includes("Key") || w.includes("密钥") ? KeyRound : TriangleAlert} className="mt-px shrink-0" />
            {w}
          </p>
        ))}
      </div>
      {item.status === "conflict" && (
        <SegmentedControl
          size="sm"
          aria-label={`${item.label} 冲突处理`}
          value={choice.overwrite ? "overwrite" : "skip"}
          onValueChange={(v) => onChange({ overwrite: v === "overwrite" })}
          options={[
            { value: "skip", label: "跳过" },
            { value: "overwrite", label: "覆盖" },
          ]}
        />
      )}
    </li>
  );
}

function ResultSummary({
  results,
  source,
  target,
  onAgain,
}: {
  results: ImportResultItem[];
  source: string;
  target: string;
  onAgain: () => void;
}) {
  const outcomes: ImportOutcome[] = ["created", "overwritten", "skipped", "unchanged", "failed"];
  const notable = results.filter((r) => r.outcome === "failed" || r.outcome === "created" || r.outcome === "overwritten" || r.warnings.length);
  const followUps = results.flatMap((r) => r.warnings.map((w) => ({ label: r.label, w })));
  return (
    <section aria-label="同步结果" className="ui-enter-up flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui font-semibold text-ink-strong">
          {source} → {target} 同步结果
        </span>
        {outcomes.map((o) => {
          const n = results.filter((r) => r.outcome === o).length;
          return n ? (
            <Badge key={o} variant={OUTCOME_VARIANT[o]}>
              {OUTCOME_LABEL[o]} {n}
            </Badge>
          ) : null;
        })}
        <span className="flex-1" />
        <Button size="sm" onClick={onAgain}>
          重新预览
        </Button>
      </div>

      {followUps.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-card border border-warn-line bg-warn-muted px-3.5 py-3 text-ui text-warn-ink">
          <Icon icon={KeyRound} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">还需要在「{target}」上手动处理：</p>
            <ul className="mt-1 list-disc pl-4 text-label">
              {followUps.map((f) => (
                <li key={`${f.label}:${f.w}`}>
                  {f.label}：{f.w}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {notable.length > 0 && (
        <ul className="overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line">
          {notable.map((r) => (
            <li key={`${r.kind}:${r.key}`} className="flex min-h-[40px] items-center gap-3 px-3 py-2 text-label">
              <Badge variant={OUTCOME_VARIANT[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Badge>
              <span className="shrink-0 text-ink-faint">{CONFIG_KIND_META[r.kind].label}</span>
              <span className="min-w-0 flex-1 truncate text-ui text-ink">{r.label}</span>
              {r.message && <span className="max-w-[50%] truncate text-ink-muted" title={r.message}>{r.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
