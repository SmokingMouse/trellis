"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, Skeleton, Switch, toast } from "@/components/ui";
import { parsePushSettings, PUSH_SETTING_KEYS, type PushSettings as Settings } from "@/lib/push";
import {
  currentSubscription,
  detectPushEnv,
  sendTestPush,
  serverKnows,
  subscribePush,
  unsubscribePush,
  type PushEnv,
} from "@/lib/push-client";

// 设置 → 偏好 → 「手机推送」：本浏览器的订阅状态 / 开关 / 测试，加上服务端的三个开关
// （总开关、完成、等你回答；存 app_settings，对所有已订阅设备生效）。

type SubState = { endpoint: string | null; known: boolean; total: number };

export function PushSettings() {
  const [env, setEnv] = useState<PushEnv | null>(null);
  const [sub, setSub] = useState<SubState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState<"sub" | "unsub" | "test" | null>(null);

  const refresh = useCallback(async () => {
    const e = detectPushEnv();
    setEnv(e);
    setPermission(e.supported ? Notification.permission : "unsupported");
    if (!e.supported || !e.secure) {
      setSub({ endpoint: null, known: false, total: 0 });
      return;
    }
    const s = await currentSubscription().catch(() => null);
    const endpoint = s?.endpoint ?? null;
    const info = await serverKnows(endpoint ?? "").catch(() => ({ known: false, total: 0 }));
    setSub({ endpoint, known: info.known, total: info.total });
  }, []);

  useEffect(() => {
    // 浏览器 API 只在挂载后能读；走 promise 回调避开 set-state-in-effect（同 prefs 页写法）。
    void Promise.resolve().then(refresh);
    void fetch("/api/settings")
      .then((r) => r.json() as Promise<{ settings: Record<string, string | null> }>)
      .then((j) => setSettings(parsePushSettings((k) => j.settings?.[k])))
      .catch(() => setSettings(parsePushSettings(() => null)));
  }, [refresh]);

  const setServerSetting = async (key: string, on: boolean) => {
    const prev = settings;
    // 缺省 = 开，所以「开」写空值删行回默认，「关」写 "0"。
    setSettings((s) => (s ? { ...s, ...patchFor(key, on) } : s));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value: on ? null : "0" }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setSettings(prev);
      toast.error("保存失败，稍后再试");
    }
  };

  const enable = async () => {
    setBusy("sub");
    try {
      await subscribePush();
      toast.success("本浏览器已开启推送");
    } catch (err) {
      toast.error("开启失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const disable = async () => {
    setBusy("unsub");
    try {
      await unsubscribePush();
      toast.success("本浏览器已关闭推送");
    } catch (err) {
      toast.error("关闭失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await sendTestPush(sub?.endpoint ?? undefined);
      if (r.sent > 0) toast.success("已发出，几秒内应收到一条测试通知");
      else if (r.removed > 0) toast.error("这个订阅已失效，已自动清除，请重新开启");
      else if (r.failed.length) toast.error("发送失败", { description: `${r.failed[0].endpointHost}：${r.failed[0].message}` });
      else toast.error("服务端没有这个浏览器的订阅，请重新开启");
    } catch (err) {
      toast.error("发送失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const ready = env !== null && sub !== null;
  const subscribed = !!sub?.endpoint && sub.known;
  const iosNeedsInstall = !!env?.ios && !env.standalone;

  return (
    <section aria-labelledby="push-settings-title" className="ui-enter-up">
      <h2 id="push-settings-title" className="text-ui font-semibold text-ink-strong mb-2">
        手机推送
      </h2>
      <div className="flex flex-col divide-y divide-line rounded-card bg-surface-raised shadow-raise px-4">
        {iosNeedsInstall && (
          <p className="py-3 text-ui text-warn-ink" role="note">
            iPhone / iPad 要先在 Safari 点「分享 → 添加到主屏幕」，再从主屏幕图标打开 Trellis，回到这里开启推送（Safari 网页里收不到推送）。
          </p>
        )}

        <div className="min-h-[52px] py-2.5 flex items-center gap-3 max-md:flex-col max-md:items-stretch">
          <div className="min-w-0 flex-1">
            <div className="text-ui font-medium text-ink">本浏览器</div>
            <div className="text-label text-ink-faint" aria-live="polite">
              {!ready ? "检测中…" : statusText(env, permission, sub, subscribed, iosNeedsInstall)}
            </div>
          </div>
          <div className="shrink-0 flex gap-2 max-md:w-full">
            {!ready ? (
              <Skeleton className="h-8 w-28" />
            ) : subscribed ? (
              <>
                <Button onClick={test} loading={busy === "test"} disabled={busy !== null}>
                  发测试
                </Button>
                <Button variant="danger" onClick={disable} loading={busy === "unsub"} disabled={busy !== null}>
                  关闭
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={enable}
                loading={busy === "sub"}
                disabled={busy !== null || !env?.supported || !env.secure || permission === "denied"}
              >
                开启推送
              </Button>
            )}
          </div>
        </div>

        <ToggleRow
          label="推送总开关"
          hint="对所有已订阅的设备生效；正在前台看着的会话不推"
          checked={settings?.enabled}
          onChange={(v) => setServerSetting(PUSH_SETTING_KEYS.enabled, v)}
        />
        <ToggleRow
          label="一轮完成"
          hint="你发起的一轮回答跑完时"
          checked={settings?.done}
          disabled={settings?.enabled === false}
          onChange={(v) => setServerSetting(PUSH_SETTING_KEYS.done, v)}
        />
        <ToggleRow
          label="等你回答"
          hint="出现待审批 / 提问时"
          checked={settings?.waiting}
          disabled={settings?.enabled === false}
          onChange={(v) => setServerSetting(PUSH_SETTING_KEYS.waiting, v)}
        />
      </div>
    </section>
  );
}

function patchFor(key: string, on: boolean): Partial<Settings> {
  if (key === PUSH_SETTING_KEYS.enabled) return { enabled: on };
  if (key === PUSH_SETTING_KEYS.done) return { done: on };
  return { waiting: on };
}

function statusText(
  env: PushEnv | null,
  permission: NotificationPermission | "unsupported",
  sub: SubState | null,
  subscribed: boolean,
  iosNeedsInstall: boolean,
): string {
  const others = sub && sub.total > (subscribed ? 1 : 0) ? `；另有 ${sub.total - (subscribed ? 1 : 0)} 台设备已订阅` : "";
  if (!env?.supported) return (iosNeedsInstall ? "需先添加到主屏幕" : "这个浏览器不支持 Web Push") + others;
  if (!env.secure) return "需要 https（或 localhost）才能开启" + others;
  if (permission === "denied") return "通知权限已被拒绝，请到系统 / 浏览器设置里允许后刷新" + others;
  if (subscribed) return "已开启" + others;
  if (sub?.endpoint) return "浏览器有订阅但服务端不认识，点开启重新登记" + others;
  return "未开启" + others;
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean | undefined;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="min-h-[52px] py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium text-ink">{label}</div>
        <div className="text-label text-ink-faint">{hint}</div>
      </div>
      <div className="shrink-0">
        {checked === undefined ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        )}
      </div>
    </div>
  );
}
