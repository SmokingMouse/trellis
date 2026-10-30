"use client";
import { useEffect, useState } from "react";
import { CloudOff } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { Button, Icon } from "@/components/ui";

// 断线不清屏：会话刷新失败、正在显示本地缓存（stores/sessionStore offline）时，顶部一条
// 不挡操作的「离线 · 重试」提示。网络恢复（online 事件）、回到前台、以及离线期间每
// RETRY_MS 自动重试一次；拿到真数据后 offline 复位，条自然消失。
const RETRY_MS = 15_000;

export function OfflineBanner() {
  const offline = useSessionStore((s) => s.offline);
  const retryOffline = useSessionStore((s) => s.retryOffline);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!offline) return;
    const retry = () => void retryOffline();
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(retry, RETRY_MS);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [offline, retryOffline]);

  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--trellis-header-h)+0.5rem)] md:left-(--trellis-sb) md:top-[5.75rem] z-40 flex justify-center px-3"
    >
      <div className="ui-enter-pop pointer-events-auto flex items-center gap-2 rounded-full bg-warn-muted py-0.5 pl-3 pr-1 text-label text-warn-ink shadow-[0_0_0_1px_var(--warn-line),var(--elev-raised)]">
        <Icon icon={CloudOff} size="sm" />
        <span>离线 · 显示的是本地缓存</span>
        <Button
          variant="ghost"
          size="sm"
          loading={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await retryOffline();
            } finally {
              setRetrying(false);
            }
          }}
        >
          重试
        </Button>
      </div>
    </div>
  );
}
