"use client";
import { useEffect, useRef, useState } from "react";
import { ReferencePicker } from "./ReferencePicker";
import { NewQuestionPicker } from "./NewQuestionPicker";

type Picker = "question" | "reference" | null;

// Bottom-right FAB. Clicking opens a small popover menu with two creation
// flows: 新话题 (fresh-context parallel root in current session) / 参考卡片.
// Remote triggers (Header B3 prompt, /clear) go through the store's
// composeRootOpen flag, consumed at page level so it works in both views —
// this FAB only handles its own menu.
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
      {/* bottom-24 clears the docked composer bar (#3) at the viewport foot. */}
      <div ref={wrapRef} className="fixed bottom-24 right-3 z-30">
        {menuOpen && (
          <div className="absolute bottom-14 right-0 w-56 bg-surface-raised border border-line rounded-lg shadow-pop py-1 text-sm ui-enter-pop">
            <MenuItem
              onClick={() => open("question")}
              icon="🧹"
              title="新话题（清空上下文）"
              hint="等价 /clear · 不继承现有节点"
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
          className="h-12 px-4 rounded-full bg-accent text-ink-inverse shadow-pop hover:bg-accent-strong active:scale-95 transition-transform flex items-center gap-2 text-sm"
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
      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-muted text-left"
    >
      <span aria-hidden className="text-base leading-none">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-ink-strong">{title}</span>
        <span className="block text-label text-ink-muted">
          {hint}
        </span>
      </span>
    </button>
  );
}
