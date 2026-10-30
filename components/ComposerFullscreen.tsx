"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUp, Minimize2 } from "lucide-react";
import { Button, Icon, IconButton } from "@/components/ui";
import { portalBody, trapTabKey } from "@/components/ui/focus";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { resolveComposerKey } from "@/lib/composer-keys";
import { sendHint, type SendKey } from "@/lib/send-key";

// 全屏长文编辑（参考 Codex 手机端的「展开」）：手机铺满可视区域、桌面是大弹窗。
// 与卡片里的输入框共用同一份草稿（value / onValueChange 由 ComposerShell 透传，
// 两边天然双向同步）。发送键语义与卡片输入框一致（lib/composer-keys.ts → lib/send-key.ts），
// Esc 收起回到卡片输入框。软键盘弹起时整块钉在键盘之上（useKeyboardInset，
// iOS 只缩 visual viewport；Android resizes-content 下 inset 恒为 0，不会双重扣减）。
//
// 用 Radix Dialog 的 modal={false} + 自做 Tab 循环，和 components/ui/Modal.tsx 同一套理由。

export function ComposerFullscreen({
  value,
  onValueChange,
  onSubmit,
  onClose,
  sendKey,
  submitLabel,
  submitDisabled,
  placeholder,
  onPaste,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** 发送（与卡片输入框同一个 onSubmit）；调用方随后关闭本面板 */
  onSubmit: () => void;
  /** 关闭回到卡片输入框；refocus=false 表示不要把焦点拉回去（发送后） */
  onClose: (refocus: boolean) => void;
  sendKey: SendKey;
  submitLabel: string;
  submitDisabled: boolean;
  placeholder?: string;
  /** 粘贴图片 / 文件 → 和卡片输入框同一条附件通路 */
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionEndAt = useRef(0);
  const keyboard = useKeyboardInset(true);

  const submit = () => {
    if (submitDisabled) return;
    onSubmit();
    onClose(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = resolveComposerKey(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        keyCode: e.keyCode,
        isComposing: e.nativeEvent.isComposing,
      },
      // Esc 交给 Radix 的 onEscapeKeyDown（document 级），这里不重复处理。
      { sendKey, compositionEndAt: compositionEndAt.current, now: Date.now(), handlesEscape: false },
    );
    if (action === "send") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose(true);
      }}
    >
      <DialogPrimitive.Portal container={portalBody()}>
        <div
          data-composer-fullscreen-shell=""
          className="fixed inset-x-0 z-60 flex md:items-center md:justify-center md:bg-scrim/50 md:p-6 ui-enter-fade"
          // 手机：可见区域 = layout viewport 去掉键盘；桌面 inset 恒为 0 → 铺满后居中。
          style={{ top: keyboard.top, bottom: keyboard.bottom }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose(true);
          }}
        >
          <DialogPrimitive.Content
            data-composer-fullscreen=""
            aria-modal="true"
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              const el = textareaRef.current;
              if (!el) return;
              el.focus({ preventScroll: true });
              el.setSelectionRange(el.value.length, el.value.length);
            }}
            // 焦点归还由调用方决定（发送后不拉回、收起时拉回卡片输入框）。
            onCloseAutoFocus={(e) => e.preventDefault()}
            // 输入法组字中的 Esc 是取消候选，不是收起。
            onEscapeKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) e.preventDefault();
            }}
            onInteractOutside={(e) => e.preventDefault()}
            onKeyDown={trapTabKey}
            className="flex h-full w-full flex-col bg-surface outline-none md:h-[min(80vh,760px)] md:max-w-3xl md:overflow-hidden md:rounded-window md:shadow-overlay ui-enter-layer"
            style={{
              // 手机全屏：顶部让出刘海；键盘弹起时底部是键盘，不再留 Home 条安全区。
              paddingTop: "var(--safe-top)",
              paddingBottom: keyboard.open ? 0 : "var(--safe-bottom)",
            }}
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-line-faint px-2 py-1.5 md:pt-2">
              <IconButton label="收起" shortcut="Esc" onClick={() => onClose(true)} data-composer-fullscreen-close="">
                <Icon icon={Minimize2} />
              </IconButton>
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate px-1 text-ui font-medium text-ink-strong">
                编辑消息
              </DialogPrimitive.Title>
              <span className="mr-1 shrink-0 text-label tabular-nums text-ink-faint" aria-hidden>
                {value.length > 0 ? `${value.length} 字` : ""}
              </span>
              <Button
                variant="ink"
                size="md"
                aria-label={submitLabel}
                data-composer-fullscreen-send=""
                onClick={submit}
                disabled={submitDisabled}
                className="shrink-0 rounded-full! pl-2.5"
              >
                <Icon icon={ArrowUp} size="sm" selected />
                {submitLabel}
              </Button>
            </div>
            <textarea
              ref={textareaRef}
              data-composer-fullscreen-input=""
              aria-label="编辑消息（全屏）"
              enterKeyHint={sendKey === "enter" ? "send" : "enter"}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              onCompositionEnd={() => {
                compositionEndAt.current = Date.now();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={placeholder}
              style={{ outline: "none" }}
              className="block min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3.5 text-body leading-relaxed text-ink-strong placeholder:text-ink-faint md:text-[14.5px] md:leading-[1.6]"
            />
            <div className="shrink-0 px-4 pb-2.5 pt-1 text-[11.5px] tabular-nums text-ink-faint max-md:hidden">
              {sendHint(sendKey)} · Esc 收起
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
