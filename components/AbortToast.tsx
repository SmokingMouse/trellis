"use client";
import { useEffect, useRef } from "react";
import { CircleStop } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { Icon, Kbd, toast } from "@/components/ui";

// Esc 中止的防误触 + 误中止恢复。W4 起不自己画 UI，把 store 状态同步进 sonner：
//   • abortArm      → 警告「再按一次 Esc 中止生成」。不自动消失，hook 解除
//     武装（窗口过期 / 第二次 Esc）时 store 置空，这里跟着撤掉。
//   • abortRecovery → 停下后给「已中止 · 重新运行」，误按一键恢复；12 秒自动消失。
const RECOVERY_MS = 12000;
const ARM_ID = "abort-arm";
const RECOVERY_ID = "abort-recovery";
let seq = 0;

export function AbortToast() {
  const arm = useSessionStore((s) => s.abortArm);
  const recovery = useSessionStore((s) => s.abortRecovery);

  // 每次武装用独立 id：同 id 在退场动画期间复用会拿到一条正被删除的 toast。
  const armId = useRef<string | null>(null);
  const armSeen = useRef<typeof arm>(null);
  useEffect(() => {
    if (armSeen.current === arm) return;
    armSeen.current = arm;
    if (armId.current) toast.dismiss(armId.current);
    armId.current = null;
    if (!arm) return;
    const id = `${ARM_ID}:${++seq}`;
    armId.current = id;
    toast.warning(
      <span>
        再按一次 <Kbd>Esc</Kbd> 中止生成
      </span>,
      {
        id,
        description: arm.label ? `「${truncate(arm.label)}」` : undefined,
        duration: Infinity,
        // 用户手动关掉提示 = 放弃这次中止。
        onDismiss: () => {
          if (useSessionStore.getState().abortArm === arm) {
            useSessionStore.getState().setAbortArm(null);
          }
        },
      },
    );
  }, [arm]);

  // 同一个 recovery 对象只发一次；换了对象（又中止了一次）换 id 从头计时。
  const recoveryId = useRef<string | null>(null);
  const recoverySeen = useRef<typeof recovery>(null);
  useEffect(() => {
    if (recoverySeen.current === recovery) return;
    recoverySeen.current = recovery;
    if (recoveryId.current) toast.dismiss(recoveryId.current);
    recoveryId.current = null;
    if (!recovery) return;
    const id = `${RECOVERY_ID}:${++seq}`;
    recoveryId.current = id;
    // 只清「还是这一条」的 store 状态，避免旧 toast 被替换时误清新的。
    const clear = () => {
      const st = useSessionStore.getState();
      if (st.abortRecovery === recovery) st.setAbortRecovery(null);
      if (recoveryId.current === id) recoveryId.current = null;
    };
    toast(`已中止${recovery.label ? `「${truncate(recovery.label)}」` : ""}`, {
      id,
      duration: RECOVERY_MS,
      icon: <Icon icon={CircleStop} className="text-ink-faint" />,
      action: {
        label: "重新运行",
        onClick: () => {
          const st = useSessionStore.getState();
          st.setActiveNode(recovery.nodeId);
          void st.retryNode(recovery.nodeId);
          clear();
        },
      },
      onDismiss: clear,
      onAutoClose: clear,
    });
  }, [recovery]);

  return null;
}

function truncate(s: string): string {
  return s.length > 30 ? s.slice(0, 29) + "…" : s;
}
