"use client";
import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from "@simplewebauthn/browser";
import { Button, ErrorCallout, Icon, Input } from "@/components/ui";
import { clearOfflineData } from "@/lib/offline-cache";

type LoginError = { title: string; hint: string; raw: unknown };

function goToDestination() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  window.location.href = from && from.startsWith("/") ? from : "/";
}

/** 浏览器端取消 / 被新一轮 ceremony 顶掉，不当错误展示。 */
function isCancel(cause: unknown): boolean {
  const name = (cause as { name?: string })?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

class PasskeyUnavailable extends Error {}
/** 用户已经选了 passkey、服务端验签没过。只有这种失败才值得重新挂 conditional 请求。 */
class PasskeyRejected extends Error {}

/**
 * Conditional UI 的后台请求：一直挂着，直到用户在密码框的自动填充建议里选了 passkey，
 * 或点了「用 Passkey 登录」（新 ceremony 会把它 abort 掉，AbortError 静默）。
 * 验签失败后重新挂上，方便换一把再试。
 */
function runAutofill(on: { unavailable: () => void; error: (cause: unknown) => void }): void {
  void browserSupportsWebAuthnAutofill().then((ok) => {
    if (!ok) return;
    passkeyLogin(true).then(goToDestination, (cause: unknown) => {
      if (cause instanceof PasskeyUnavailable) return on.unavailable();
      if (isCancel(cause)) return;
      on.error(cause);
      // 只在「选了但没通过」后重挂；取 challenge 就失败（断网等）不重挂，免得空转刷请求。
      if (cause instanceof PasskeyRejected) runAutofill(on);
    });
  });
}

/**
 * 一次 Passkey 登录：取 challenge → 认证器（Face ID / 指纹）签名 → 服务端验签并签发
 * 与口令登录相同的 cookie。autofill=true 走 conditional UI（密码框的自动填充里选 passkey）。
 */
async function passkeyLogin(autofill: boolean): Promise<void> {
  const optRes = await fetch("/api/login/passkey/options", { method: "POST" });
  if (optRes.status === 409 || optRes.status === 400) throw new PasskeyUnavailable();
  if (optRes.status === 429) throw new Error((await optRes.json().catch(() => ({})))?.error ?? "尝试次数过多");
  if (!optRes.ok) throw new Error(`HTTP ${optRes.status}`);
  const optionsJSON = await optRes.json();
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  const res = await fetch("/api/login/passkey/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new PasskeyRejected(data?.error || `HTTP ${res.status}`);
  }
}

// Themed login page (replaces the browser's Basic-Auth prompt). Posts the
// password to /api/login, which sets the session cookie; then a full navigation
// to the original destination so middleware re-evaluates with the cookie set.
// Inherits the app's theme automatically — the root layout's pre-hydration
// script has already applied `html.dark`, so the dark: variants below match.
//
// W4：控件换原语（Input / Button / ErrorCallout），克制工具风；品牌渐变 logo 保留
// （刻意裁决：品牌渐变不随皮肤变化）。#pw 与唯一的 button[type=submit] 是
// scripts/mobile-verify/* 的登录钩子，别改。
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);
  // null = 还没探测；false = 浏览器不支持或服务端未启用（隐藏按钮）
  const [passkeyOk, setPasskeyOk] = useState<boolean | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const showPasskeyError = useCallback((cause: unknown) => {
    setError({
      title: "Passkey 登录没有成功",
      hint: "可以再试一次，或用访问密码登录。",
      raw: cause instanceof Error ? cause.message : cause,
    });
  }, []);

  // Conditional UI：浏览器支持时，挂一个「自动填充里可选 passkey」的后台请求（见 runAutofill）。
  const startAutofill = useCallback(
    () => runAutofill({ unavailable: () => setPasskeyOk(false), error: showPasskeyError }),
    [showPasskeyError],
  );

  useEffect(() => {
    // 延后一拍，让状态更新发生在 effect 之外（项目既有 lint 约束）。
    void Promise.resolve().then(() => {
      const ok = browserSupportsWebAuthn();
      setPasskeyOk(ok);
      if (ok) startAutofill();
    });
    return () => WebAuthnAbortService.cancelCeremony();
  }, [startAutofill]);

  async function loginWithPasskey() {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setError(null);
    try {
      await passkeyLogin(false);
      goToDestination();
      return;
    } catch (cause) {
      setPasskeyBusy(false);
      if (cause instanceof PasskeyUnavailable) {
        setPasskeyOk(false);
        setError({ title: "这个地址没有启用 Passkey", hint: "请用访问密码登录。", raw: "" });
        return;
      }
      if (!isCancel(cause)) showPasskeyError(cause);
    }
    // 显式 ceremony 顶掉了后台的 conditional 请求，失败 / 取消后再挂回去。
    startAutofill();
  }

  // 落到登录页 = 登出 / cookie 失效 / 换了 token：清掉本机的会话缓存（IndexedDB）与
  // SW 的 app shell 缓存，下一个登录的人看不到上一个人的会话内容。
  useEffect(() => {
    void clearOfflineData();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        goToDestination();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(
        res.status === 401
          ? { title: "密码不对", hint: "检查大小写后再输一次。", raw: "" }
          : res.status === 429
            ? { title: "尝试次数过多", hint: data?.error || "稍后再试。", raw: "" }
          : {
              title: "登录没有成功",
              hint: "服务端出了问题，稍后再试。",
              raw: data?.error || `HTTP ${res.status}`,
            },
      );
      setBusy(false);
    } catch (cause) {
      setError({ title: "连不上 Trellis 服务", hint: "检查网络或服务是否在运行，然后重试。", raw: cause });
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-6 bg-surface-canvas text-ink-strong">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-7">
          {/* 品牌渐变固定色（原 indigo/fuchsia/amber 500·500·400 的 hex 原值） */}
          {/* ui-guard-allow(hex): 品牌渐变 logo（不随皮肤，刻意裁决） */}
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]" />
          <h1 className="mt-4 text-title font-semibold tracking-tight text-ink-strong">Trellis</h1>
          <p className="mt-1 text-ui text-ink-muted">
            图状的 AI 对话
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={submit}
          className="rounded-card border border-line bg-surface p-6 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pw" className="text-ui font-medium text-ink">
              访问密码
            </label>
            <Input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password webauthn"
              value={password}
              invalid={error !== null}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              placeholder="输入密码以继续"
              className="min-h-10"
            />
          </div>
          {error && (
            <ErrorCallout compact error={error.raw} title={error.title} hint={error.hint} />
          )}
          <Button
            type="submit"
            variant="primary"
            className="w-full min-h-10"
            loading={busy}
            disabled={!password}
          >
            进入
          </Button>
          {passkeyOk && (
            <>
              <div className="flex items-center gap-3 text-label text-ink-faint" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                或
                <span className="h-px flex-1 bg-line" />
              </div>
              {/* type=button：表单里唯一的 submit 必须是上面的「进入」（mobile-verify 钩子） */}
              <Button
                type="button"
                variant="secondary"
                className="w-full min-h-10"
                loading={passkeyBusy}
                onClick={() => void loginWithPasskey()}
                data-passkey-login
              >
                <Icon icon={KeyRound} />
                用 Passkey 登录
              </Button>
            </>
          )}
        </form>

        <p className="mt-5 text-center text-label text-ink-faint">
          受保护的私有部署 · 仅限授权访问
        </p>
      </div>
    </div>
  );
}
