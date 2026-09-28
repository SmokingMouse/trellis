"use client";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster as SonnerToaster, toast, useSonner } from "sonner";

// 全站统一的 toast 出口（sonner）。新代码只这样用：
//   import { toast } from "@/components/ui";
//   toast.success("已保存"); toast.error("保存失败", { description: "…" });
//   toast("已归档", { action: { label: "撤销", onClick: undo } });
// <Toaster/> 在根布局挂一次（AppProviders），右下角，主题跟随 <html class="dark">。
//
// 过渡期（W4 前）旧的四套 toast（DoneToast / TaskToast / AbortToast /
// StreamAlertToast）还在，都带 data-legacy-toast。有新 toast 在场时每 400ms 量一次
// 旧堆叠的顶边，把 sonner 整体往上推，保证新旧不重叠；没有新 toast 时不测量。
export { toast };

const GAP = 8;
const BASE = 16;

function useLegacyToastOffset(active: boolean): number {
  const [offset, setOffset] = useState(BASE);
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      let top = window.innerHeight;
      document.querySelectorAll<HTMLElement>("[data-legacy-toast]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0) top = Math.min(top, r.top);
      });
      const next = top < window.innerHeight ? window.innerHeight - top + GAP : BASE;
      setOffset((prev) => (prev === next ? prev : next));
    };
    measure();
    const id = window.setInterval(measure, 400);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? offset : BASE;
}

function useHtmlDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains("dark"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export function Toaster() {
  const { toasts } = useSonner();
  const bottom = useLegacyToastOffset(toasts.length > 0);
  const dark = useHtmlDark();
  return (
    <SonnerToaster
      theme={dark ? "dark" : "light"}
      position="bottom-right"
      offset={{ bottom, right: BASE }}
      mobileOffset={{ bottom, left: 12, right: 12 }}
      gap={GAP}
      visibleToasts={4}
      closeButton
      containerAriaLabel="通知"
      style={{ zIndex: 70 }}
      icons={{
        success: <CircleCheck size={16} strokeWidth={1.75} className="text-positive" />,
        info: <Info size={16} strokeWidth={1.75} className="text-ink-faint" />,
        warning: <TriangleAlert size={16} strokeWidth={1.75} className="text-warn" />,
        error: <CircleAlert size={16} strokeWidth={1.75} className="text-danger" />,
        loading: <LoaderCircle size={16} strokeWidth={2} className="animate-spin text-ink-faint" />,
        close: <X size={12} strokeWidth={2} />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group flex w-full items-start gap-2.5 rounded-card border border-line bg-surface-raised px-3 py-2.5 text-ui text-ink shadow-overlay",
          icon: "mt-0.5 flex shrink-0",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "font-medium text-ink-strong",
          description: "text-label text-ink-muted",
          actionButton:
            "ml-2 shrink-0 self-center rounded-field bg-accent px-2 min-h-6.5 text-label font-medium text-accent-fg hover:bg-accent-strong",
          cancelButton:
            "ml-2 shrink-0 self-center rounded-field border border-line-strong px-2 min-h-6.5 text-label text-ink hover:bg-surface-hover",
          closeButton:
            "absolute -left-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line bg-surface-raised text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink",
          error: "border-danger-line",
          warning: "border-warn-line",
        },
      }}
    />
  );
}
