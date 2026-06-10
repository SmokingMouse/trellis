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
    <div className="min-h-screen flex items-center justify-center px-6 bg-stone-100 dark:bg-stone-950 text-stone-900 dark:text-stone-100">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400 shadow-sm" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Trellis</h1>
          <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
            图状的 AI 对话
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={submit}
          className="rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-sm p-6"
        >
          <label
            htmlFor="pw"
            className="block text-[12px] font-medium text-stone-500 dark:text-stone-400 mb-1.5"
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
            className={`w-full h-11 px-3.5 rounded-lg bg-white dark:bg-stone-950 border text-[15px] outline-none transition-colors ${
              error
                ? "border-rose-400 dark:border-rose-700 focus:border-rose-500"
                : "border-stone-300 dark:border-stone-700 focus:border-indigo-400 dark:focus:border-indigo-500"
            }`}
          />
          {error && (
            <p className="mt-2 text-[12.5px] text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full h-11 rounded-lg bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-[14px] font-medium hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
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

        <p className="mt-5 text-center text-[11px] text-stone-400 dark:text-stone-500">
          受保护的私有部署 · 仅限授权访问
        </p>
      </div>
    </div>
  );
}
