"use client";
import { useState } from "react";
import { ReferencePicker } from "./ReferencePicker";

// Bottom-right floating "+" — current Phase A scope only opens the
// reference picker. Once we add more node-creation flows (eg. "blank qa"
// or "note") we can swap this for a small popover menu.
export function AddNodeFAB() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-3 z-30 h-12 px-4 rounded-full bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 shadow-lg hover:bg-stone-800 dark:hover:bg-stone-300 active:scale-95 transition-transform flex items-center gap-2 text-sm"
        title="添加参考卡片"
        aria-label="添加参考卡片"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>参考</span>
      </button>
      {open && <ReferencePicker onClose={() => setOpen(false)} />}
    </>
  );
}
