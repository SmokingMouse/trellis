"use client";
import { useState } from "react";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { basename } from "@/lib/run-config";

// S89: 「选一个工作目录」这个控件。新会话（ModePicker）和任务定义（/settings/tasks）
// 共用同一份。
//
// 这是三处运行配置里**唯一真正同一个的控件**，所以只有它被抽成组件（其余共享的是文案，
// 见 lib/run-config.ts 的文件头）。抽它的理由不是省代码，是任务页原来那个
// **裸的绝对路径 <input>** —— 它不接 workspaces 表、不校验路径存不存在、不能建 worktree
// 或 scratch 目录，用户得先去别处把路径复制出来。WorkspacePicker 这些全有。
//
// 密度差异靠 className 调（draft 里是一枚 chip、表单里是整行），不做 variant 分支。

export function WorkspaceField({
  value,
  onChange,
  /** 必填态：空值时按钮变红并轻微脉冲，提示这里不能留空。 */
  required = false,
  /** 空值时按钮上的字。 */
  placeholder = "选择工作区",
  className = "",
  open: openProp,
  onOpenChange,
}: {
  value: string | null;
  onChange: (path: string | null) => void;
  required?: boolean;
  placeholder?: string;
  className?: string;
  /** 受控开合。ModePicker 用它保留「切到 project 就自动弹出」那条既有行为
   *  —— 不给的话组件自己管，表单里用的就是这种。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = (v: boolean) => {
    if (!controlled) setOpenState(v);
    onOpenChange?.(v);
  };
  const missing = required && !value;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // title 给完整路径 —— 按钮上只显示最后一段，但用户需要能确认到底是哪个目录。
        title={value ?? "请选择工作区目录"}
        // min-w-0 是给里面那个 truncate 用的 —— flex item 默认 min-width:auto，
        // 不给 0 的话长路径会把按钮撑破而不是省略。宽度完全由 className 决定
        // （chip 传 max-w-*，表单传 w-full）。
        className={`inline-flex min-w-0 items-center gap-1.5 h-7 px-2 rounded-md border text-label font-medium transition-colors ${
          missing
            ? "border-danger-line bg-danger-muted text-danger-ink animate-pulse"
            : "border-line-strong bg-surface text-ink hover:bg-surface-muted"
        } ${className}`}
      >
        <span aria-hidden>📁</span>
        <span className="truncate font-mono">
          {value ? basename(value) : placeholder}
        </span>
      </button>

      {open && (
        <WorkspacePicker
          currentPath={value}
          onPick={(p) => onChange(p)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
