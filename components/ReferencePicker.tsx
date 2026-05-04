"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

type Mode = "paste" | "url";

export function ReferencePicker({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("paste");
  const [pastedText, setPastedText] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createReference = useSessionStore((s) => s.createReference);
  const provider = useSessionStore((s) => s.provider);
  const fetcherDescription =
    provider === "codex"
      ? "由本机 codex CLI + 已配置的 MCP servers / plugins 决定怎么抓——YOLO 模式下它能直接 spawn feishu-cli、yt-dlp、curl 等工具。需要授权的平台预先 auth login 即可。"
      : "由本机 claude + 已安装的 skills 决定怎么抓——飞书文档自动走 feishu-cli，YouTube 走字幕 skill，普通网页走 web-fetch，等等。需要授权的平台预先 auth login 即可。";
  const firstField = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  // Esc to close — but only when no field has focus, since textareas
  // already capture Esc for their own use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA")
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === "paste") {
        const trimmed = pastedText.trim();
        if (!trimmed) {
          setError("粘贴的内容不能为空");
          setBusy(false);
          return;
        }
        await createReference({
          sourceType: "paste",
          pastedText: trimmed,
          title: title.trim() || undefined,
        });
      } else {
        const u = url.trim();
        if (!u) {
          setError("URL 不能为空");
          setBusy(false);
          return;
        }
        await createReference({ sourceType: "url", url: u });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/40 dark:bg-black/60 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-stone-900 rounded-xl shadow-2xl overflow-hidden border border-transparent dark:border-stone-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-stone-100 dark:border-stone-800 flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-stone-900 dark:text-stone-100">
              添加参考卡片
            </div>
            <div className="text-[12px] text-stone-500 dark:text-stone-400 mt-0.5">
              背景资料挂在画布上不发给 LLM；划词追问时只把选区送过去。
            </div>
          </div>
          <button
            onClick={onClose}
            className="px-2 py-1 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="px-5 pt-3 flex gap-1 text-sm">
          <TabButton active={mode === "paste"} onClick={() => setMode("paste")}>
            📄 粘贴文本
          </TabButton>
          <TabButton active={mode === "url"} onClick={() => setMode("url")}>
            🔗 URL 抓取
          </TabButton>
        </div>

        <div className="px-5 py-4">
          {mode === "paste" ? (
            <>
              <input
                ref={firstField as React.RefObject<HTMLInputElement>}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="标题（可选）"
                className="w-full px-3 py-2 mb-2 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 text-sm outline-none focus:border-stone-500 dark:focus:border-stone-500 placeholder:text-stone-400 dark:placeholder:text-stone-500"
              />
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="把背景文本粘到这里…"
                rows={10}
                className="w-full px-3 py-2 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 text-sm outline-none focus:border-stone-500 dark:focus:border-stone-500 resize-none font-mono leading-relaxed placeholder:text-stone-400 dark:placeholder:text-stone-500"
              />
              <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1">
                ⌘↩ 创建 · {pastedText.length} 字
              </div>
            </>
          ) : (
            <>
              <input
                ref={firstField as React.RefObject<HTMLInputElement>}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="https://...（网页 / 飞书 / YouTube / B站 / X / PDF 都行）"
                className="w-full px-3 py-2 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 text-sm outline-none focus:border-stone-500 dark:focus:border-stone-500 placeholder:text-stone-400 dark:placeholder:text-stone-500"
              />
              <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1.5 leading-relaxed">
                <div>{fetcherDescription}</div>
                <div className="mt-0.5">抓取耗时 5-30 秒；失败也会创建空卡片留有错误信息，可点刷新重试。</div>
              </div>
            </>
          )}
          {error && (
            <div className="mt-3 text-[12px] text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded px-2.5 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-stone-100 dark:border-stone-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3.5 py-1.5 text-sm rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "处理中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-[13px] transition-colors ${
        active
          ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
          : "text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
      }`}
    >
      {children}
    </button>
  );
}
