"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Icon, IconButton, Kbd, Modal } from "@/components/ui";
import {
  SHORTCUTS,
  OPEN_HELP_EVENT,
  isEditableTarget,
} from "@/lib/shortcuts";

// 快捷键帮助面板：`?`（非输入态）或 /help 命令打开。
// 数据源 = lib/shortcuts.ts 注册表——快捷键可发现性的唯一入口，
// 此前 J/K/B/F/⌘K 等全靠散落 placeholder 根本找不到。
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onEvent = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener(OPEN_HELP_EVENT, onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_HELP_EVENT, onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;

  const groups = new Map<string, typeof SHORTCUTS>();
  for (const s of SHORTCUTS) {
    const list = groups.get(s.scope) ?? [];
    list.push(s);
    groups.set(s.scope, list);
  }

  return (
    <Modal onClose={() => setOpen(false)} closeOnEsc="always" title="键盘快捷键">
      <div className="px-5 py-4 border-b border-line-faint flex items-center justify-between">
        <div className="text-reading font-semibold text-ink-strong">
          键盘快捷键
        </div>
        <IconButton label="关闭" onClick={() => setOpen(false)}>
          <Icon icon={X} />
        </IconButton>
      </div>
      <div className="px-5 py-4 max-h-[60vh] overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
        {Array.from(groups.entries()).map(([scope, items]) => (
          <div key={scope}>
            <div className="text-nano uppercase tracking-wide text-ink-faint mb-1.5">
              {scope}
            </div>
            <ul className="flex flex-col gap-1">
              {items.map((s) => (
                <li key={s.keys + s.label} className="flex items-center gap-3">
                  <span className="shrink-0 min-w-16">
                    <Kbd className="text-label">{s.keys}</Kbd>
                  </span>
                  <span className="text-ui text-ink">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="px-5 py-2.5 border-t border-line-faint text-label text-ink-faint">
        随时按 <Kbd>?</Kbd>{" "}
        打开本面板 · 输入框里输 /help 也可以
      </div>
    </Modal>
  );
}
