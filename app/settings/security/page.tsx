"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  PageHeader,
  Skeleton,
  toast,
  useConfirm,
} from "@/components/ui";
import { formatRelativeTime } from "@/lib/relative-time";

type PasskeyItem = {
  id: string;
  name: string;
  rpId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? `HTTP ${res.status}`;
}

/** 浏览器端取消 / 超时（用户在 Face ID 弹窗点了取消）不当错误处理。 */
function isCancel(cause: unknown): boolean {
  const name = (cause as { name?: string })?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

// 登录与 Passkey：在已登录状态下给这台 Trellis 添加 passkey（iPhone / Mac 的 Face ID、
// Touch ID，或硬件钥匙），之后登录页可直接用它进入。口令登录始终保留作兜底。
export default function SecuritySettingsPage() {
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const confirm = useConfirm();

  const load = useCallback((): Promise<void> => {
    setError(null);
    return fetch("/api/passkeys", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        setItems(((await res.json()) as { passkeys: PasskeyItem[] }).passkeys);
      })
      .catch((cause: unknown) => setError(cause ?? new Error("Passkey 列表加载失败")));
  }, []);

  useEffect(() => {
    // 延后一拍，让状态更新发生在 effect 之外（项目既有 lint 约束）。
    void Promise.resolve().then(() => {
      setSupported(browserSupportsWebAuthn());
      return load();
    });
  }, [load]);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const optRes = await fetch("/api/passkeys/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error(await readError(optRes));
      const optionsJSON = await optRes.json();
      const response = await startRegistration({ optionsJSON });
      const res = await fetch("/api/passkeys/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, response }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const { passkey } = (await res.json()) as { passkey: PasskeyItem };
      setItems((cur) => [passkey, ...(cur ?? [])]);
      setName("");
      toast.success(`已添加「${passkey.name}」`);
    } catch (cause) {
      if ((cause as { name?: string })?.name === "InvalidStateError") {
        toast.error("这台设备上已经有这里的 passkey 了");
      } else if (!isCancel(cause)) {
        toast.error(`添加失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      setAdding(false);
    }
  };

  const remove = async (item: PasskeyItem) => {
    const ok = await confirm({
      title: `删除「${item.name}」？`,
      description: "删除后这把 passkey 不能再登录 Trellis；已经登录的设备不受影响。设备上残留的 passkey 条目可在系统密码管理里手动清掉。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/passkeys/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(await readError(res));
      setItems((cur) => cur?.filter((p) => p.id !== item.id) ?? cur);
      toast.success("已删除");
    } catch (cause) {
      toast.error(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="登录与 Passkey"
        count={items?.length}
        countUnit="把"
        subtitle="添加 passkey 后，登录页可用 Face ID / Touch ID 直接进入；口令登录始终可用"
        actions={
          <IconButton label="刷新" onClick={() => void load()}>
            <Icon icon={RefreshCw} />
          </IconButton>
        }
      />

      <section aria-labelledby="passkey-add-title" className="ui-enter-up rounded-card bg-surface-raised shadow-raise p-4 flex flex-col gap-3">
        <h2 id="passkey-add-title" className="text-ui font-semibold text-ink-strong">
          添加 Passkey
        </h2>
        {!supported ? (
          <p className="text-label text-ink-muted">
            当前浏览器不支持 Passkey（需要 HTTPS 或 localhost 下的现代浏览器）。
          </p>
        ) : (
          <form
            className="flex items-end gap-2 max-md:flex-col max-md:items-stretch"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor="passkey-name" className="text-label text-ink-muted">
                名称（可选，方便区分设备）
              </label>
              <Input
                id="passkey-name"
                value={name}
                maxLength={64}
                placeholder="例如：我的 iPhone"
                onChange={(e) => setName(e.target.value)}
                className="min-h-10"
              />
            </div>
            <Button type="submit" variant="primary" className="min-h-10" loading={adding} data-passkey-add>
              <Icon icon={KeyRound} />
              添加 Passkey
            </Button>
          </form>
        )}
        <p className="text-label text-ink-faint">
          Passkey 绑定当前访问的域名：在公网地址添加的只能在公网地址登录，localhost 同理。
        </p>
      </section>

      {error !== null && <ErrorCallout error={error} title="Passkey 列表加载失败" onRetry={() => void load()} />}

      {items === null && error === null && (
        <div role="status" aria-label="加载中" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={KeyRound}
          title="还没有 Passkey"
          description="在上面添加一把，之后在登录页点「用 Passkey 登录」即可。"
          className="rounded-card bg-surface-raised shadow-raise"
        />
      )}

      {items && items.length > 0 && (
        <ul
          aria-label="已添加的 Passkey"
          className="ui-enter-up overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line"
          style={{ animationDelay: "60ms" }}
        >
          {items.map((item) => (
            <li
              key={item.id}
              data-passkey-id={item.id}
              className="flex min-h-[46px] items-center gap-3 px-3 py-2 text-label transition-colors duration-100 hover:bg-surface-hover max-md:flex-wrap"
            >
              <Icon icon={KeyRound} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink" title={item.name}>
                {item.name}
              </span>
              <Badge className="shrink-0 font-mono text-[11.5px]">{item.rpId}</Badge>
              {item.backedUp && <Badge variant="positive" className="shrink-0">已同步</Badge>}
              <span className="shrink-0 tabular-nums text-ink-muted">
                创建于 {formatRelativeTime(item.createdAt)} ·{" "}
                {item.lastUsedAt ? `最近使用 ${formatRelativeTime(item.lastUsedAt)}` : "尚未使用"}
              </span>
              <Button
                size="sm"
                variant="secondary"
                data-passkey-delete
                loading={busyId === item.id}
                disabled={busyId !== null}
                onClick={() => void remove(item)}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
