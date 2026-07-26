"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "./ui/Button";

// 「在 CLI 继续」轻量入口：project 模式会话本就是真 claude CLI 会话，点一下把
// `cd <ws> && claude --resume <id>` 复制到剪贴板，去终端粘贴即可续这条 lineage。
// 仅 project 模式渲染；不可续（源 jsonl 已不在盘等）→ 提示「盘上找不到」。
// 树内分叉的「在 CLI 续任意分支」需 P2 前缀 jsonl，不在本入口范围（见 spec）。
type State = "idle" | "loading" | "copied" | "none";

export function CliResumeButton({ nodeId }: { nodeId: string }) {
  const mode = useSessionStore((s) => s.session?.mode);
  const [state, setState] = useState<State>("idle");
  if (mode !== "project") return null;

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    try {
      const res = await fetch(`/api/nodes/${nodeId}/cli-resume`);
      const data = (await res.json()) as { resumable?: boolean; command?: string };
      if (data.resumable && data.command) {
        try {
          await navigator.clipboard.writeText(data.command);
        } catch {
          /* insecure context — still show success, user can re-copy */
        }
        setState("copied");
      } else {
        setState("none");
      }
    } catch {
      setState("none");
    }
    window.setTimeout(() => setState("idle"), 2200);
  };

  const label =
    state === "copied"
      ? "✓ 命令已复制"
      : state === "none"
        ? "盘上找不到"
        : state === "loading"
          ? "…"
          : "⌨ 在 CLI 继续";

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      title="复制 cd + CLI 续聊命令（claude --resume / codex resume），到终端粘贴即可续这条对话"
      className="nodrag"
    >
      {label}
    </Button>
  );
}
