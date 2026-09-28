"use client";
import { useEffect, useRef } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { toast } from "@/components/ui";

const AUTO_DISMISS_MS = 8000;
let seq = 0;

// #5: 服务端还没建节点就失败的流（请求被拒 / 非 2xx / 服务重启）。以前这类错误
// 被静默丢掉（handleStreamEvent 的 error 分支需要 nodeId），输入框看起来像死了。
// W4 起不自己画 UI：store.streamAlert 同步成一条 sonner 错误提示，8 秒自动消失；
// 关掉 / 超时后清 store。
export function StreamAlertToast() {
  const alert = useSessionStore((s) => s.streamAlert);
  const current = useRef<string | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (seen.current === alert) return;
    seen.current = alert;
    if (current.current) toast.dismiss(current.current);
    current.current = null;
    if (!alert) return;
    const id = `stream-alert:${++seq}`;
    current.current = id;
    const clear = () => {
      const st = useSessionStore.getState();
      if (st.streamAlert === alert) st.setStreamAlert(null);
      if (current.current === id) current.current = null;
    };
    // store 里的文案形如「发送失败：…」「数据库写入失败…」，本身就是完整的一句话，
    // 直接当标题；不另拼 description。
    toast.error(alert, {
      id,
      duration: AUTO_DISMISS_MS,
      onDismiss: clear,
      onAutoClose: clear,
    });
  }, [alert]);

  return null;
}
