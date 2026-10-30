"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Laptop, Network, Plus, RefreshCw, Server, Unplug, X } from "lucide-react";
import {
  Badge,
  Button,
  buttonVariants,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Spinner,
  StatusDot,
  Switch,
  Textarea,
  toast,
  useConfirm,
} from "@/components/ui";
import { createNodePairing, fetchNodes, revokeNode, setNodePolicy } from "@/lib/gw-client";
import type { GwNode, GwNodeCreateResponse, GwNodePolicy } from "@/lib/gw-types";
import { copyText } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/relative-time";

// 机器互联（hub + node）。两块：
//   ① hub 上的机器 —— /__gw/api/nodes 只由网关提供；直连单人版时落到 Next 404，
//      这是「当前不是经 hub 访问」，不是故障（同共享池页的判据）。
//   ② 本机接入 hub —— /api/hub-node，由本机 trellis 自己提供，任何实例都有。
// 两块互不依赖：公司 devbox 直连打开时只有 ②，经 hub 打开时两块都有。

type LocalHub = {
  configured: boolean;
  source: "env" | "file" | null;
  hubURL: string | null;
  nodeName: string | null;
  connected: boolean | null;
  viaHub: string | null;
};

function isGatewayAbsent(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

const shortSha = (v: string | null) => (v ? v.slice(0, 7) : null);

export default function NodesSettingsPage() {
  const [nodes, setNodes] = useState<GwNode[] | null>(null);
  const [gwError, setGwError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback((): Promise<void> => {
    return fetchNodes()
      .then((list) => {
        setNodes(list);
        setGwError(null);
      })
      .catch((err: unknown) => setGwError(err ?? new Error("网关不可达")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const gatewayAbsent = gwError !== null && isGatewayAbsent(gwError);

  const handleRevoke = async (node: GwNode) => {
    const ok = await confirm({
      title: `撤销机器「${node.name}」？`,
      description: "隧道会立刻断开，它的 token 永久失效。之后要再接入，得重新生成连接串。那台机器上的数据不受影响。",
      confirmLabel: "撤销",
      danger: true,
    });
    if (!ok) return;
    setBusyName(node.name);
    try {
      await revokeNode(node.name);
      toast.success(`已撤销「${node.name}」`);
      await load();
    } catch (err) {
      toast.error("撤销失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setBusyName(null);
    }
  };

  const handlePolicy = async (node: GwNode, patch: Partial<GwNodePolicy>) => {
    try {
      const { policy } = await setNodePolicy(node.name, patch);
      setNodes((list) => list?.map((n) => (n.name === node.name ? { ...n, policy } : n)) ?? list);
    } catch (err) {
      toast.error("保存失败", { description: err instanceof Error ? err.message : "稍后重试" });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="机器互联"
        count={nodes ? nodes.length : undefined}
        countUnit="台机器"
        subtitle="一个入口访问多台机器：执行和数据都留在各自机器上，hub 只做转发"
        actions={
          <>
            <IconButton label="刷新" className="md:bg-surface-raised md:shadow-btn" onClick={() => void load()} disabled={loading}>
              <Icon icon={RefreshCw} />
            </IconButton>
            <Button variant="primary" onClick={() => setAdding(true)} disabled={gwError !== null}>
              <Icon icon={Plus} />
              添加机器
            </Button>
          </>
        }
      />

      <section>
        <div className="mb-2">
          <h2 className="text-ui font-semibold text-ink-strong">hub 上的机器</h2>
          <p className="text-label text-ink-muted">切换后整页都由那台机器提供；离线的机器只显示状态</p>
        </div>

        {gatewayAbsent && (
          <EmptyState
            icon={Unplug}
            title="当前不是经 hub 访问"
            description="机器列表由 hub（多租户网关）提供。要把这台机器挂到某个 hub 上，用下面的「本机接入 hub」。"
            className="rounded-card bg-surface-raised shadow-raise md:py-8"
          />
        )}

        {gwError !== null && !gatewayAbsent && (
          <ErrorCallout
            error={gwError}
            title="连不上 hub"
            hint="确认是经 hub 地址访问的、且网关在运行，然后重试。"
            onRetry={() => void load()}
          />
        )}

        {gwError === null && loading && !nodes && (
          <div role="status" aria-label="加载中" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-card bg-surface-raised p-3.5 shadow-raise flex flex-col gap-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {gwError === null && nodes && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node, i) => (
              <NodeRow
                key={node.name}
                index={i}
                node={node}
                busy={busyName === node.name}
                onRevoke={() => void handleRevoke(node)}
                onPolicy={(patch) => void handlePolicy(node, patch)}
              />
            ))}
          </ul>
        )}
      </section>

      <LocalHubSection />

      {adding && (
        <AddNodeModal
          onClose={() => setAdding(false)}
          nodes={nodes ?? []}
          onCreated={() => void load()}
        />
      )}
    </div>
  );
}

function NodeRow({
  node,
  index,
  busy,
  onRevoke,
  onPolicy,
}: {
  node: GwNode;
  index: number;
  busy: boolean;
  onRevoke: () => void;
  onPolicy: (patch: Partial<GwNodePolicy>) => void;
}) {
  const sha = shortSha(node.version);
  // .mcard：键值对（版本 / 连上于 / 最后心跳），值用 mono；没有的数据不编。
  const kv: [string, string][] = node.online
    ? [
        ...(sha ? ([["版本", sha]] as [string, string][]) : []),
        ...(node.connectedAt ? ([["连上于", formatRelativeTime(node.connectedAt)]] as [string, string][]) : []),
      ]
    : [["最后心跳", node.lastSeenAt ? formatRelativeTime(node.lastSeenAt) : "从未连上"]];

  return (
    <li
      className="ui-enter-up flex flex-col gap-3 rounded-card bg-surface-raised p-3.5 shadow-raise"
      style={{ animationDelay: `${Math.min(index, 5) * 60}ms` }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={node.kind === "home" ? Server : Laptop} className="text-ink-muted" />
        <span className="min-w-0 truncate font-mono text-[13.5px] font-semibold text-ink-strong">{node.name}</span>
        {node.current && <Badge variant="accent">当前</Badge>}
        <span className="flex-1" />
        {node.kind === "home" && <Badge>本机</Badge>}
        <Badge variant={node.online ? "positive" : "neutral"}>{node.online ? "在线" : "离线"}</Badge>
      </div>
      {kv.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-label">
          {kv.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-faint">{k}</dt>
              <dd className="truncate text-right font-mono text-[11.5px] tabular-nums text-ink-muted">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* 外流策略：远端机器默认全关（多是公司 devbox），网关据此拦 /api/export/* 和派活。 */}
      <div className="flex flex-col gap-1.5 text-label">
        <PolicySwitch
          label="允许内容离开这台机器"
          machine={node.name}
          hint="会话接力、配置同步、向别的机器派活时作为来源"
          checked={node.policy.shareOut}
          onChange={(v) => onPolicy({ shareOut: v })}
        />
        <PolicySwitch
          label="允许别的机器往这台派活"
          machine={node.name}
          hint="其他机器上的 agent 可以在这台新开会话执行任务"
          checked={node.policy.acceptDispatch}
          onChange={(v) => onPolicy({ acceptDispatch: v })}
        />
      </div>
      {(!node.current || node.kind === "remote") && (
        <div className="mt-auto flex items-center gap-2">
          {!node.current &&
            (node.online ? (
              // 整页导航而不是 router.push：切 node 换的是整个后端，客户端状态必须清干净。
              <a
                href={`/__gw/go/${encodeURIComponent(node.name)}/settings/nodes`}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                切换到这台
              </a>
            ) : (
              <Button size="sm" disabled>
                切换到这台
              </Button>
            ))}
          {node.kind === "remote" && (
            <Button size="sm" variant="danger" className="ml-auto" onClick={onRevoke} loading={busy}>
              撤销
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function PolicySwitch({
  label,
  machine,
  hint,
  checked,
  onChange,
}: {
  label: string;
  machine: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block text-ink">{label}</span>
        <span className="block text-[11.5px] text-ink-faint">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={`${machine}：${label}`} />
    </label>
  );
}

function AddNodeModal({
  onClose,
  nodes,
  onCreated,
}: {
  onClose: () => void;
  nodes: GwNode[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<GwNodeCreateResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!created) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [created]);

  const joined = created ? nodes.find((n) => n.name === created.name && n.online) : undefined;
  const remainingSec = created ? Math.max(0, Math.round((created.expiresAt - now) / 1000)) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!/^[a-z0-9-]{1,32}$/.test(trimmed)) {
      setError("名称只能用小写字母、数字和连字符（1–32 个字符）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setCreated(await createNodePairing(trimmed));
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await copyText(created.connectionString);
      toast.success("连接串已复制");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  };

  return (
    <Modal onClose={() => !busy && onClose()} size="lg" title="添加机器" panelClassName="p-5 flex flex-col gap-4 max-h-[90vh]">
      <div className="flex items-center justify-between pb-3 border-b border-line">
        <h3 className="text-body font-semibold text-ink-strong">添加机器</h3>
        <IconButton label="关闭" size="sm" onClick={onClose} disabled={busy}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>

      {!created ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-ui text-ink-muted leading-relaxed">
            给新机器起个名字。生成的连接串 10 分钟内有效、只能用一次；在那台机器上用它换取长期凭证后，它会主动连上 hub——那台机器只需要能出站，外面连不进去也没关系。
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-label text-ink-muted">名称</span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="office"
              maxLength={32}
              aria-invalid={error ? true : undefined}
            />
          </label>
          {error && <p className="text-label text-danger-ink" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} disabled={busy}>取消</Button>
            <Button type="submit" variant="primary" loading={busy}>生成连接串</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3 overflow-y-auto">
          <div className="flex items-center gap-2 text-ui">
            {joined ? (
              <>
                <StatusDot tone="positive" />
                <span className="text-ink-strong font-medium">{created.name} 已连上 hub</span>
              </>
            ) : remainingSec > 0 ? (
              <>
                <Spinner label={null} />
                <span className="text-ink-muted">
                  等待 {created.name} 连接… 连接串还剩 <span className="tabular-nums">{Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, "0")}</span>
                </span>
              </>
            ) : (
              <span className="text-warn-ink">连接串已过期，关掉重新生成即可</span>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-label text-ink-muted">连接串</span>
            <Textarea readOnly rows={3} value={created.connectionString} className="font-mono text-nano" onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div>
            <Button size="sm" onClick={() => void copy()}>
              <Icon icon={Copy} size="sm" />
              复制
            </Button>
          </div>

          <div className="rounded-card bg-surface-canvas shadow-hairline px-3 py-2.5 text-label text-ink-muted leading-relaxed flex flex-col gap-1.5">
            <div className="text-ink font-medium">在新机器上二选一：</div>
            <div>① 打开那台机器自己的 trellis →「设置 → 机器互联 → 本机接入 hub」，粘贴连接串</div>
            <div>
              ② ssh 上去，在 trellis 仓库目录执行：
              <code className="block mt-1 font-mono text-nano text-ink break-all">make node-connect CONN=&apos;{created.connectionString}&apos;</code>
            </div>
            <div className="text-ink-faint">连接串里写的 hub 地址是 {created.hub}，新机器必须能访问它。</div>
          </div>

          <div className="flex justify-end">
            <Button variant={joined ? "primary" : "secondary"} onClick={onClose}>{joined ? "完成" : "关闭"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function LocalHubSection() {
  const [state, setState] = useState<LocalHub | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [conn, setConn] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback((): Promise<void> => {
    return fetch("/api/hub-node", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setState(body as LocalHub);
        setError(null);
      })
      .catch((err: unknown) => setError(err ?? new Error("读取失败")));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!conn.trim()) return;
    const ok = await confirm({
      title: "把这台机器接入 hub？",
      description: "接入后，hub 的管理员可以经隧道以本机身份使用这台 trellis 的全部功能（包括在这台机器上跑 agent、读写文件）。只接入你自己控制的 hub。",
      confirmLabel: "接入",
    });
    if (!ok) return;
    setBusy(true);
    setFormError(null);
    try {
      const r = await fetch("/api/hub-node", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionString: conn }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setConn("");
      toast.success(`已接入 ${body.hubURL}`, { description: "几秒内隧道会自动连上。" });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "接入失败");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "断开与 hub 的连接？",
      description: state?.viaHub
        ? "你现在正是经这个 hub 打开的本页——断开后这个页面会立刻失联，只能在那台机器本地或重新配对才能恢复。"
        : "hub 上这台机器会显示离线。之后要再接入，需要在 hub 上重新生成连接串。",
      confirmLabel: "断开",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch("/api/hub-node", { method: "DELETE" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      toast.success("已断开");
      await load();
    } catch (err) {
      toast.error("断开失败", { description: err instanceof Error ? err.message : "稍后重试" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-2">
        <h2 className="text-ui font-semibold text-ink-strong">本机接入 hub</h2>
        <p className="text-label text-ink-muted">让这台机器主动连出到某个 hub，从 hub 那边就能访问它</p>
      </div>

      {error !== null && (
        <ErrorCallout error={error} title="读不到本机接入状态" onRetry={() => void load()} />
      )}

      {error === null && !state && (
        <div className="rounded-card bg-surface-raised shadow-raise px-4 py-3">
          <Skeleton className="h-3.5 w-1/3" />
        </div>
      )}

      {state?.configured && (
        <div className="ui-enter-up rounded-card bg-surface-raised shadow-raise px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap text-ui">
              <StatusDot tone={state.connected ? "positive" : "warn"} label={state.connected ? "已连上" : "未连上"} />
              <span className="text-ink-strong">
                以 <span className="font-mono">{state.nodeName}</span> 接入 <span className="font-mono">{state.hubURL}</span>
              </span>
            </div>
            <div className="text-label text-ink-muted mt-1">
              {state.connected ? "隧道已连上" : state.connected === null ? "读不到隧道状态" : "正在连接或重连中（断线后会自动重试）"}
              {state.source === "env" && " · 配置来自服务环境变量，要改请改服务定义"}
            </div>
          </div>
          {state.source === "file" && (
            <Button size="sm" variant="danger" onClick={() => void disconnect()} loading={busy}>
              断开
            </Button>
          )}
        </div>
      )}

      {state && !state.configured && (
        <form onSubmit={connect} className="ui-enter-up rounded-card bg-surface-raised shadow-raise p-4 flex flex-col gap-3">
          <div className="flex items-start gap-2.5 text-ui text-ink-muted">
            <Icon icon={Network} className="mt-0.5 text-ink-faint" />
            <span>在 hub 的「机器互联 → 添加机器」里生成连接串，粘贴到这里。</span>
          </div>
          <Textarea
            rows={3}
            value={conn}
            onChange={(e) => setConn(e.target.value)}
            placeholder="trellis://v1/…"
            className="font-mono text-nano resize-none"
            aria-label="连接串"
            aria-invalid={formError ? true : undefined}
          />
          {formError && <p className="text-label text-danger-ink" role="alert">{formError}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!conn.trim()}>
              接入
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
