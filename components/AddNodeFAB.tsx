"use client";
import { useEffect, useRef, useState } from "react";
import { ReferencePicker } from "./ReferencePicker";
import { NewQuestionPicker } from "./NewQuestionPicker";

type Picker = "question" | "reference" | null;

// Bottom-right FAB. Clicking opens a small popover menu with two creation
// flows: 新提问 (parallel root in current session) / 参考卡片 (paste / URL).
export function AddNodeFAB() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<Picker>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const open = (kind: Picker) => {
    setMenuOpen(false);
    setPicker(kind);
  };

  return (
    <>
      <div ref={wrapRef} className="fixed bottom-6 right-3 z-30">
        {menuOpen && (
          <div className="absolute bottom-14 right-0 w-56 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg shadow-xl py-1 text-sm">
            <MenuItem
              onClick={() => open("question")}
              icon="💬"
              title="新提问"
              hint="独立的根问答"
            />
            <MenuItem
              onClick={() => open("reference")}
              icon="📄"
              title="参考卡片"
              hint="粘贴 / URL"
            />
          </div>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="h-12 px-4 rounded-full bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 shadow-lg hover:bg-stone-800 dark:hover:bg-stone-300 active:scale-95 transition-transform flex items-center gap-2 text-sm"
          title="新建节点"
          aria-label="新建节点"
          aria-expanded={menuOpen}
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
            className={`transition-transform ${menuOpen ? "rotate-45" : ""}`}
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>新建</span>
        </button>
      </div>
      {picker === "question" && (
        <NewQuestionPicker onClose={() => setPicker(null)} />
      )}
      {picker === "reference" && (
        <ReferencePicker onClose={() => setPicker(null)} />
      )}
    </>
  );
}

function MenuItem({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800/60 text-left"
    >
      <span aria-hidden className="text-base leading-none">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-stone-900 dark:text-stone-100">{title}</span>
        <span className="block text-[11px] text-stone-500 dark:text-stone-400">
          {hint}
        </span>
      </span>
    </button>
  );
}
