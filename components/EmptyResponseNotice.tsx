"use client";
import { useSessionStore } from "@/stores/sessionStore";

// 「不在流式、response 又是空」时该显示什么。
//
// 这里以前一律画成脉冲点 +「正在生成…」，于是每一种「这轮本来就没有文本」都被
// 伪装成一个永不结束的 loading。最难受的是镜像会话：一条被 CLI 注入切歪的 turn
// （见 lib/server/cli-import.ts 的 isTurnStart）会带着满格工具调用、空 response
// 挂在那儿转圈，界面上完全看不出它其实已经结束了。
//
// 现在只有一种情况敢说「正在生成」：镜像会话正被一个活着的 claude 进程实时写
// （liveSessionIds 由 session_updated 事件续期）。此时空 response 的确只是还没
// 落盘。其余情况据实交代。
export function EmptyResponseNotice({
  hasToolCalls,
}: {
  hasToolCalls: boolean;
}) {
  const mirrorLive = useSessionStore(
    (s) =>
      s.session?.origin === "cli-import" && s.liveSessionIds.has(s.session.id),
  );

  if (mirrorLive) {
    return (
      <div className="text-ink-faint italic flex items-center gap-2">
        <span className="w-1.5 h-1.5 bg-positive rounded-full animate-pulse" />
        CLI 正在生成…（镜像会话，落盘后同步）
      </div>
    );
  }

  // 措辞刻意留了余地（「暂无」而不是「没有」）：镜像会话的 live 判定靠 jsonl 写盘
  // 心跳，而 CLI 跑长命令时会静默很久（实测 13.78% 的间隔 > 12s）。TTL 已放宽到
  // 60s，但仍可能在超长工具调用中途褪去 —— 那时说死「没有输出」就是反向误导。
  return (
    <div className="text-ink-faint italic">
      {hasToolCalls ? "本轮暂无文本回复（只有工具调用）" : "本轮暂无输出"}
    </div>
  );
}
