"use client";
import { useState } from "react";

// Themed login page (replaces the browser's Basic-Auth prompt). Posts the
// password to /api/login, which sets the session cookie; then a full navigation
// to the original destination so middleware re-evaluates with the cookie set.
// Inherits the app's theme automatically — the root layout's pre-hydration
// script has already applied `html.dark`, so the dark: variants below match.
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      setError(data?.error || "登录失败");
      setBusy(false);
    } catch {
      setError("网络错误，请重试");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-surface-canvas text-ink-strong">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8">
          {/* 品牌渐变固定色（原 indigo/fuchsia/amber 500·500·400 的 hex 原值） */}
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24] shadow-raise" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Trellis</h1>
          <p className="mt-1 text-ui text-ink-muted">
            图状的 AI 对话
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={submit}
          className="rounded-card border border-line bg-surface shadow-raise p-6"
        >
          <label
            htmlFor="pw"
            className="block text-ui font-medium text-ink-muted mb-1.5"
          >
            访问密码
          </label>
          <input
            id="pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            placeholder="输入密码以继续"
            className={`w-full h-11 px-3.5 rounded-field bg-surface-canvas border text-reading outline-none transition-colors ${
              error
                ? "border-danger focus:border-danger"
                : "border-line-strong focus:border-accent"
            }`}
          />
          {error && (
            <p className="mt-2 text-ui text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full h-11 rounded-field bg-accent hover:bg-accent-strong text-ink-inverse text-body font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                登录中…
              </>
            ) : (
              "进入"
            )}
          </button>
        </form>

        <p className="mt-5 text-center text-label text-ink-faint">
          受保护的私有部署 · 仅限授权访问
        </p>
      </div>
    </div>
  );
}
