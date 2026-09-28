"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Check, SquareTerminal } from "lucide-react";
import { Button, Icon, toast } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import { isHerdrSession } from "@/lib/herdr-ui";

// 「在 CLI 继续」轻量入口：project 模式本就是真 CLI thread，复制对应 family 的
// resume 命令到剪贴板，去终端即可续这条 lineage。
// 仅 project 模式渲染；不可续（源会话记录文件已不在盘上等）→ 提示「本机找不到会话记录」。
// 树内分叉的「在 CLI 续任意分支」需 P2 前缀 jsonl，不在本入口范围（见 spec）。
type State = "idle" | "loading" | "copied" | "none";

export function CliResumeButton({ nodeId }: { nodeId: string }) {
  const mode = useSessionStore((s) => s.session?.mode);
  const session = useSessionStore((s) => s.session);
  const { fleet } = useHerdrFleet();
  const [state, setState] = useState<State>("idle");
  if (mode !== "project" || isHerdrSession(session, fleet)) return null;

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    try {
      const res = await fetch(`/api/nodes/${nodeId}/cli-resume`);
      const data = (await res.json()) as { resumable?: boolean; command?: string };
      if (data.resumable && data.command) {
        try {
          await copyText(data.command);
        } catch {
          /* clipboard unavailable — still show success, user can re-copy */
        }
        setState("copied");
        toast.success("续聊命令已复制", { description: "到终端粘贴即可接着这条对话继续。" });
      } else {
        setState("none");
      }
    } catch {
      setState("none");
    }
    window.setTimeout(() => setState("idle"), 2200);
  };

  const label =
    state === "copied" ? (
      <>
        <Icon icon={Check} size="sm" />
        命令已复制
      </>
    ) : state === "none" ? (
      "本机找不到会话记录"
    ) : (
      <>
        <Icon icon={SquareTerminal} size="sm" />
        在 CLI 继续
      </>
    );

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      loading={state === "loading"}
      title="复制 cd + CLI 续聊命令（claude --resume / codex resume），到终端粘贴即可续这条对话"
      className="nodrag"
    >
      {label}
    </Button>
  );
}
