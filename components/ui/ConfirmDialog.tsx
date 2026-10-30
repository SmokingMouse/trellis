"use client";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { useSyncExternalStore, type ReactNode } from "react";
import { buttonVariants } from "./Button";
import { cn } from "./cn";
import { SHEET_MODAL_QUERY, useMediaQuery } from "./sheet";

// 确认框（Radix AlertDialog）——用来替换 window.confirm（W4 迁移调用点）。
//
// 文案规范：title 写成问句（「删除这棵树？」），description 写后果
// （「树里 12 个节点和笔记会一起删除，无法恢复。」）。破坏性动作传 danger，
// 确认按钮变实心红——全站只有这里用 danger-solid。
//
// 两种用法：
//   受控组件：<ConfirmDialog open onOpenChange title … onConfirm />
//   Promise 式：const confirm = useConfirm();
//              if (!(await confirm({ title, description, danger: true }))) return;
// Promise 式依赖根布局挂的 <ConfirmHost/>（AppProviders 里）；万一没挂，退回
// window.confirm，不会静默吞掉确认。
//
// 形态：桌面（≥md）居中小卡；手机（<md）iOS 风 action sheet——贴底，标题 / 说明 +
// 全宽 48px 主按钮（danger 时实心红）一块，「取消」单独一块。

export type ConfirmOptions = {
  /** 问句：「删除这棵树？」 */
  title: string;
  /** 后果说明：删了会怎样、能不能撤销 */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
}: ConfirmOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const sheet = useMediaQuery(SHEET_MODAL_QUERY);
  const titleEl = (
    <AlertDialogPrimitive.Title
      className={sheet ? "text-ui font-semibold text-ink-strong" : "text-body font-semibold text-ink-strong"}
    >
      {title}
    </AlertDialogPrimitive.Title>
  );
  const descriptionEl = description ? (
    <AlertDialogPrimitive.Description
      className={sheet ? "mt-1 text-label text-ink-muted" : "mt-1.5 text-ui text-ink-muted"}
    >
      {description}
    </AlertDialogPrimitive.Description>
  ) : (
    <AlertDialogPrimitive.Description className="sr-only">{title}</AlertDialogPrimitive.Description>
  );

  if (sheet) {
    return (
      <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="ui-sheet-scrim fixed inset-0 z-60 bg-scrim/50" />
          <AlertDialogPrimitive.Content
            data-confirm-dialog
            data-confirm-sheet
            className="ui-action-sheet fixed inset-x-0 bottom-0 z-60 mx-auto flex w-full max-w-md flex-col gap-2 outline-none"
            style={{
              paddingBottom: "calc(0.5rem + var(--safe-bottom))",
              paddingLeft: "calc(0.5rem + var(--safe-left))",
              paddingRight: "calc(0.5rem + var(--safe-right))",
            }}
          >
            <div className="overflow-hidden rounded-sheet bg-surface-raised shadow-overlay">
              <div className="px-4 pb-3 pt-4 text-center">
                {titleEl}
                {descriptionEl}
              </div>
              <div className="px-3 pb-3">
                <AlertDialogPrimitive.Action
                  // 不复用 buttonVariants：它的 max-md:min-h-11 / rounded-field 会和这里的 48px / 圆角打架（cn 不做 merge）
                  className={cn(
                    "press flex min-h-12 w-full select-none items-center justify-center rounded-card px-4 text-body font-semibold text-accent-fg",
                    danger ? "bg-danger active:bg-danger-strong" : "bg-accent active:bg-accent-strong",
                  )}
                  onClick={onConfirm}
                >
                  {confirmLabel}
                </AlertDialogPrimitive.Action>
              </div>
            </div>
            <AlertDialogPrimitive.Cancel className="press min-h-12 shrink-0 rounded-sheet bg-surface-raised text-body font-semibold text-ink shadow-overlay active:bg-surface-hover">
              {cancelLabel}
            </AlertDialogPrimitive.Cancel>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    );
  }

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="ui-scrim fixed inset-0 z-60 bg-scrim/50" />
        <div
          className="pointer-events-none fixed inset-0 z-60 flex items-center justify-center"
          style={{
            paddingTop: "var(--safe-top)",
            paddingBottom: "var(--safe-bottom)",
            paddingLeft: "calc(1rem + var(--safe-left))",
            paddingRight: "calc(1rem + var(--safe-right))",
          }}
        >
          <AlertDialogPrimitive.Content
            data-confirm-dialog
            className="ui-layer pointer-events-auto w-full max-w-sm rounded-window bg-surface-raised p-5 shadow-overlay outline-none"
          >
            {titleEl}
            {descriptionEl}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialogPrimitive.Cancel className={buttonVariants({ variant: "secondary" })}>
                {cancelLabel}
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action
                className={cn(buttonVariants({ variant: danger ? "danger-solid" : "primary" }))}
                onClick={onConfirm}
              >
                {confirmLabel}
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </div>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

// ── Promise 式：模块级队列 + 根布局的 ConfirmHost ─────────────────────────
type Pending = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const current = () => queue[0] ?? null;

/** 弹一个确认框，用户点确认 → true，取消 / Esc / 点外面 → false。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  // 不再回退原生 window.confirm：ConfirmHost 在根布局（AppProviders）常驻，
  // 挂载前入队的请求会在它挂载后由 useSyncExternalStore 读到并弹出。
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    emit();
  });
}

/** Hook 形态，返回稳定的 confirmDialog。 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirmDialog;
}

function settle(id: number, ok: boolean) {
  const hit = queue.find((p) => p.id === id);
  if (!hit) return;
  queue = queue.filter((p) => p.id !== id);
  hit.resolve(ok);
  emit();
}

export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, current, () => null);
  if (!pending) return null;
  return (
    <ConfirmDialog
      key={pending.id}
      open
      onOpenChange={(open) => {
        if (!open) settle(pending.id, false);
      }}
      onConfirm={() => settle(pending.id, true)}
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      danger={pending.danger}
    />
  );
}
