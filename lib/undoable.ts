"use client";
import { toast } from "@/components/ui";

// Delete-with-undo: the caller has already hidden the thing locally; the
// real (irreversible) write runs only after the toast's undo window closes.
// Closing the tab inside the window flushes pending commits on pagehide, so
// "关掉页面" never silently cancels a delete the user confirmed.

const UNDO_WINDOW_MS = 6000;

const pending = new Set<() => void>();
let flushBound = false;

function bindFlush() {
  if (flushBound || typeof window === "undefined") return;
  flushBound = true;
  window.addEventListener("pagehide", () => {
    for (const run of [...pending]) run();
  });
}

export function deleteWithUndo({
  title,
  description,
  commit,
  undo,
  onError,
}: {
  title: string;
  description?: string;
  commit: () => Promise<unknown>;
  undo: () => void;
  onError?: (err: unknown) => void;
}): void {
  bindFlush();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(run);
    commit().catch((err) => {
      if (onError) onError(err);
      else
        toast.error("删除失败", {
          description: err instanceof Error ? err.message : String(err),
        });
    });
  };
  const timer = setTimeout(run, UNDO_WINDOW_MS);
  pending.add(run);
  toast(title, {
    description,
    duration: UNDO_WINDOW_MS,
    action: {
      label: "撤销",
      onClick: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(run);
        undo();
      },
    },
  });
}
