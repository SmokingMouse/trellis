"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { providerFamily } from "@/lib/llm";
import { CircleAlert, FileText, Link, Paperclip, X } from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
} from "@/components/ui";

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
    providerFamily(provider) === "codex"
      ? "由本机 codex CLI + 已配置的 MCP servers / plugins 决定怎么抓——YOLO 模式下它能直接 spawn feishu-cli、yt-dlp、curl 等工具。需要授权的平台预先 auth login 即可。"
      : "由本机 claude + 已安装的 skills 决定怎么抓——飞书文档自动走 feishu-cli，YouTube 走字幕 skill，普通网页走 web-fetch，等等。需要授权的平台预先 auth login 即可。";
  const firstField = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // C1 (file attachment, text/code subset): read a local text/code file into
  // the paste box (wrapped as a code block). Binary formats (PDF/Excel/Word)
  // need a parser dependency — out of scope here; accept whitelists text-ish
  // extensions so FileReader.readAsText doesn't produce garbage.
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("文件过大（>1MB），请改为粘贴关键片段");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const ext = file.name.includes(".") ? file.name.split(".").pop()! : "";
      setPastedText("```" + ext + "\n" + text + "\n```");
      setTitle((t) => t || file.name);
      setMode("paste");
      setError(null);
    };
    reader.onerror = () => setError("读取文件失败");
    reader.readAsText(file);
  };

  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  // Esc to close（input/textarea 聚焦时不拦截）由 Modal 默认的
  // closeOnEsc="outside-inputs" 提供，与旧手写监听语义一致。

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
    <Modal onClose={onClose}>
        <div className="px-5 py-4 border-b border-line-faint flex items-center justify-between">
          <div>
            <div className="text-reading font-semibold text-ink-strong">
              添加参考卡片
            </div>
            <div className="text-ui text-ink-muted mt-0.5">
              背景资料挂在画布上不发给 LLM；划词追问时只把选区送过去。
            </div>
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <Icon icon={X} />
          </IconButton>
        </div>

        <div className="px-5 pt-3">
          <SegmentedControl
            aria-label="参考来源"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "paste", label: "粘贴文本", icon: FileText },
              { value: "url", label: "URL 抓取", icon: Link },
            ]}
          />
        </div>

        <div className="px-5 py-4">
          {mode === "paste" ? (
            <>
              <Input
                ref={firstField as React.RefObject<HTMLInputElement>}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="标题（可选）"
                className="mb-2"
              />
              <Textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="把背景文本粘到这里…"
                rows={10}
                className="resize-none font-mono"
              />
              <div className="text-label text-ink-faint mt-1 flex items-center justify-between gap-2">
                <span>⌘↩ 创建 · {pastedText.length} 字</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  title="读取本地代码/文本文件（PDF/Excel/Word 暂需粘贴或后续支持）"
                >
                  <Icon icon={Paperclip} size="sm" />
                  从文件读取
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.markdown,.js,.jsx,.ts,.tsx,.py,.json,.csv,.html,.css,.scss,.go,.rs,.java,.c,.cpp,.h,.hpp,.sh,.bash,.zsh,.yml,.yaml,.xml,.sql,.toml,.ini,.conf,.log,.rb,.php,.swift,.kt,.lua,.r,.vue,.svelte"
                onChange={handleFile}
                className="hidden"
              />
            </>
          ) : (
            <>
              <Input
                ref={firstField as React.RefObject<HTMLInputElement>}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="https://...（网页 / 飞书 / YouTube / B站 / X / PDF 都行）"
              />
              <div className="text-label text-ink-faint mt-1.5 leading-relaxed">
                <div>{fetcherDescription}</div>
                <div className="mt-0.5">抓取耗时 5-30 秒；失败也会创建空卡片留有错误信息，可点刷新重试。</div>
              </div>
            </>
          )}
          {error && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-field border border-danger-line bg-surface px-2.5 py-1.5 text-ui text-danger-ink">
              <Icon icon={CircleAlert} size="sm" className="mt-0.5" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-faint flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            创建
          </Button>
        </div>
    </Modal>
  );
}
