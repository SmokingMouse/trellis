"use client";
import { useState } from "react";
import { Button, ErrorCallout, Input } from "@/components/ui";

type LoginError = { title: string; hint: string; raw: unknown };

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
        const params = new URLSearchParams(window.location.search);
        const from = params.get("from");
        window.location.href = from && from.startsWith("/") ? from : "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(
        res.status === 401
          ? { title: "密码不对", hint: "检查大小写后再输一次。", raw: "" }
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
              autoComplete="current-password"
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
        </form>

        <p className="mt-5 text-center text-label text-ink-faint">
          受保护的私有部署 · 仅限授权访问
        </p>
      </div>
    </div>
  );
}
