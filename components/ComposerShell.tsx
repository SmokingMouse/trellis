"use client";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Clock3, Maximize2 } from "lucide-react";
import { Button, Icon, IconButton } from "@/components/ui";
import { ComposerFullscreen } from "./ComposerFullscreen";
import { resolveComposerKey } from "@/lib/composer-keys";
import type { SendKey } from "@/lib/send-key";

// 输入框外壳：常规会话（Composer）与 Herdr 会话（HerdrComposer）共用同一副外观与交互，
// 各自只填语义内容。
//
// 外壳负责：
//   - 描边卡片 + focus-within 描边环、拖入文件时的高亮；
//   - 自动长高的 textarea（最高 160px）、输入法组字保护、发送键判定（lib/composer-keys.ts）；
//   - 底栏布局：左 chip 行（chips，手机收起时隐藏）→ 工具图标（tools）→ 右侧「发送到」（sendTo）→ 主按钮（primary）；
//   - 手机端 mobileCompact：收成一行（输入框 + compactTools + primary），聚焦 / 拖入展开，
//     失焦且没有未完成内容（keepExpanded=false）时收回；
//   - 卡外：提示 / 通知行、状态条（statusBar）、排队列表、补全面板（suggestions，浮在卡片上方）；
//   - 全屏长文编辑（fullscreen 给了才有）：桌面工具区常驻一个「展开」；手机收起态不放
//     （收起态只留「输入框 + 附件 + 主按钮」），展开态里输入框聚焦或写到 ≥3 行才出现。
//     打开 ComposerFullscreen，同一份 value 双向同步，发送走同一个 onSubmit。
// 调用方负责：文字状态、发送 / 停止语义、补全数据、附件上传。
//
// 手机展开态是受控的（mobileExpanded + onMobileExpandedChange）：发送后收回、拖入后展开
// 这类决定属于调用方的提交流程。

const FULLSCREEN_MIN_LINES = 3;

/** 输入框按当前宽度折行后的行数（先撑回 auto 再量，autosize effect 随后会重设高度）。 */
function countLines(el: HTMLTextAreaElement): number {
  const style = getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 1;
  const prev = el.style.height;
  el.style.height = "auto";
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const lines = Math.round((el.scrollHeight - (Number.isFinite(padding) ? padding : 0)) / lineHeight);
  el.style.height = prev;
  return Math.max(1, lines);
}

export type ComposerQueueItem = {
  id: string;
  text: string;
  /** 行首状态字，默认「排队中」 */
  label?: string;
  /** 文本后的弱化补充（如「+2 附件」） */
  meta?: string;
  /** 行尾动作（撤回 / 打断后立即发送…），按顺序渲染成 ghost 小按钮 */
  actions: { label: string; onClick: () => void; disabled?: boolean; tone?: "neutral" | "danger" }[];
  /** 可就地编辑：给了就在动作前多一个「编辑」，保存时回调新文本 */
  onEdit?: (text: string) => void;
};

type DataAttributes = { [key: `data-${string}`]: string | undefined };

export function ComposerShell({
  textareaRef,
  value,
  onValueChange,
  onSubmit,
  onEscape,
  sendKey,
  onSlashKeyDown,
  suggestions,
  disabled,
  dropDisabled = disabled,
  placeholder,
  compactPlaceholder = "追问…",
  mobileCompact = false,
  mobileExpanded = false,
  onMobileExpandedChange,
  keepExpanded = false,
  focusToken,
  banner,
  attachments,
  onPaste,
  onDropFiles,
  chips,
  tools,
  compactTools,
  sendTo,
  primary,
  state,
  notice,
  hintLeft,
  hintRight,
  queue,
  queueHeader,
  queueOpen,
  statusBar,
  fullscreen,
  beforeCard,
  afterCard,
  rootProps,
  textareaProps,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** 输入框内的 Esc（本地语义）；不传则 Esc 交给全局处理 */
  onEscape?: () => void;
  sendKey: SendKey;
  /** 补全面板的键盘导航（useSlashNav.handleKeyDown）；返回 true 表示已消费 */
  onSlashKeyDown?: (e: KeyboardEvent) => boolean;
  /** 补全面板（绝对定位在卡片上方） */
  suggestions?: ReactNode;
  disabled: boolean;
  /** 拖入是否禁用；默认同 disabled */
  dropDisabled?: boolean;
  placeholder: string;
  compactPlaceholder?: string;
  mobileCompact?: boolean;
  mobileExpanded?: boolean;
  onMobileExpandedChange?: (expanded: boolean) => void;
  /** 手机端失焦时仍有未完成内容（文字 / 附件 / 通知 / 弹窗）→ 不收回 */
  keepExpanded?: boolean;
  /** 变化时把焦点拉进输入框（手机端顺便展开） */
  focusToken?: number | null;
  /** 卡内顶部横幅 */
  banner?: ReactNode;
  /** 卡内输入框上方（附件预览），手机收起时隐藏 */
  attachments?: ReactNode;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** 拖入文件（只响应 Files 拖拽） */
  onDropFiles?: (e: DragEvent<HTMLDivElement>) => void;
  /** 左侧 chip 行（模式 / 模型）；手机端（mobileCompact）不显示 */
  chips?: ReactNode;
  /** chip 之后的工具图标（附件 / 草图） */
  tools?: ReactNode;
  /** 手机收起态里、主按钮之前的工具图标 */
  compactTools?: ReactNode;
  /** 右侧「发送到 / 发往」 */
  sendTo?: ReactNode;
  /** 主按钮（发送 / 停止 / 加载） */
  primary: ReactNode;
  /** data-composer-state：由调用方给出（stopping / compact / expanded） */
  state: string;
  notice?: ReactNode;
  hintLeft?: ReactNode;
  hintRight?: ReactNode;
  queue?: ComposerQueueItem[];
  /** 排队列表顶部的状态行（已暂停 · 继续发送…） */
  queueHeader?: ReactNode;
  /** 排队列表是否展开；不传 = 有排队就一直显示（Herdr 输入框的老行为） */
  queueOpen?: boolean;
  /** 卡片上方的紧凑状态条（ComposerStatusBar）；没内容时调用方传空，不占高度 */
  statusBar?: ReactNode;
  /** 全屏长文编辑：给了才出现「展开」按钮；label / disabled 描述面板里的发送按钮 */
  fullscreen?: { submitLabel: string; submitDisabled: boolean };
  beforeCard?: ReactNode;
  afterCard?: ReactNode;
  rootProps?: DataAttributes;
  textareaProps?: DataAttributes & Pick<HTMLAttributes<HTMLTextAreaElement>, "aria-label">;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  // 手机展开态「全屏」入口的显隐依据：输入框聚焦中，或内容 ≥ FULLSCREEN_MIN_LINES 行。
  const [inputFocused, setInputFocused] = useState(false);
  const [measuredLines, setMeasuredLines] = useState(1);
  const compositionEndAt = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const compact = mobileCompact && !mobileExpanded;
  const setExpanded = (next: boolean) => onMobileExpandedChange?.(next);
  const setExpandedRef = useRef(setExpanded);
  useEffect(() => {
    setExpandedRef.current = setExpanded;
  });

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [textareaRef, value, mobileCompact, mobileExpanded]);

  useEffect(() => {
    if (focusToken == null) return;
    const id = window.requestAnimationFrame(() => {
      if (mobileCompact) setExpandedRef.current(true);
      textareaRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusToken, mobileCompact, textareaRef]);

  const expandMobile = () => {
    if (mobileCompact) setExpanded(true);
  };

  const collapseMobileIfEmpty = () => {
    if (!mobileCompact) return;
    window.requestAnimationFrame(() => {
      if (rootRef.current?.contains(document.activeElement)) return;
      if (keepExpanded) return;
      setExpanded(false);
    });
  };

  const multiline =
    measuredLines >= FULLSCREEN_MIN_LINES || value.split("\n").length >= FULLSCREEN_MIN_LINES;
  const showExpand = !mobileCompact || (!compact && (inputFocused || multiline));
  const expandButton = fullscreen && showExpand && (
    <IconButton
      label="全屏编辑"
      // 不抢输入框焦点：触屏点按时 mousedown 会先让 textarea 失焦，按钮随之
      // 被「聚焦才显示」藏掉，click 就落空了。
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setFullscreenOpen(true)}
      disabled={disabled}
      data-composer-fullscreen-open=""
    >
      <Icon icon={Maximize2} />
    </IconButton>
  );

  const closeFullscreen = (refocus: boolean) => {
    setFullscreenOpen(false);
    if (!refocus) return;
    // 回到卡片输入框（手机端顺带展开），光标放末尾。
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      if (mobileCompact) setExpandedRef.current(true);
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
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
      { sendKey, compositionEndAt: compositionEndAt.current, now: Date.now(), handlesEscape: !!onEscape },
    );
    if (action === "ignore") return;
    // Suggestion navigation first — while the "/" dropdown is open,
    // Enter picks the highlighted item instead of sending.
    if (onSlashKeyDown?.(e)) return;
    if (action === "send") {
      e.preventDefault();
      onSubmit();
    } else if (action === "escape") {
      e.preventDefault();
      onEscape?.();
    }
  };

  return (
    <div
      ref={rootRef}
      data-mobile-composer
      data-composer-state={state}
      {...rootProps}
      className={`relative ${compact ? "py-1" : "pt-2 pb-3 max-md:py-2"}`}
      onBlur={collapseMobileIfEmpty}
    >
      {suggestions}
      {beforeCard}
      {statusBar}
      {queue && queue.length > 0 && queueOpen !== false && <ComposerQueueList items={queue} header={queueHeader} />}
      <div
        data-composer-card=""
        className={`rounded-card border bg-surface transition-[border-color,box-shadow] duration-100 focus-within:border-accent-line focus-within:ring-3 focus-within:ring-focus-ring ${
          dragOver ? "border-accent ring-3 ring-accent-line" : "border-line-strong"
        }`}
        onDragOver={(e) => {
          // Only react to file drags (Files type), ignore text drags.
          if (!onDropFiles || dropDisabled || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          // Moving between children fires dragleave on the card too.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          if (!onDropFiles || dropDisabled) return;
          onDropFiles(e);
          if (mobileCompact) setExpanded(true);
        }}
      >
        {banner}
        {!compact && attachments}
        <div className={compact ? "flex items-center gap-1 pr-1" : undefined}>
          <textarea
            data-composer-input
            {...textareaProps}
            ref={textareaRef}
            // 手机键盘回车键标签：Enter 发送时显示「发送」，⌘↩ 模式保持换行语义。
            enterKeyHint={sendKey === "enter" ? "send" : "enter"}
            value={value}
            onChange={(e) => {
              setMeasuredLines(countLines(e.target));
              onValueChange(e.target.value);
            }}
            onCompositionEnd={() => {
              compositionEndAt.current = Date.now();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => {
              setInputFocused(true);
              expandMobile();
            }}
            onBlur={(e) => {
              const el = e.currentTarget;
              // 焦点可能只是在卡内按钮间短暂切换：下一帧还不在输入框才算失焦。
              window.requestAnimationFrame(() => setInputFocused(document.activeElement === el));
            }}
            rows={1}
            // 焦点环画在外层卡片上（focus-within）；全局 :focus-visible 不在
            // layer 里、utility 压不住，只能内联去掉输入框自己的那一圈。
            style={{ outline: "none" }}
            disabled={disabled}
            placeholder={compact ? compactPlaceholder : placeholder}
            className={`block w-full min-w-0 resize-none bg-transparent text-body text-ink-strong outline-none placeholder:text-ink-faint disabled:opacity-50 ${
              compact
                ? "flex-1 h-11 min-h-11 max-h-11 px-3 py-2.5"
                : "min-h-12 max-h-40 px-3.5 pt-3 pb-1 leading-relaxed max-md:min-h-18"
            }`}
          />
          {compact && (
            <>
              {compactTools}
              {primary}
            </>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            {!mobileCompact && chips && (
              <div className="flex min-w-0 items-center gap-1.5 mr-1" data-composer-context="">
                {chips}
              </div>
            )}
            {tools}
            {expandButton}
            <span className="flex-1" />
            {sendTo}
            {primary}
          </div>
        )}
      </div>
      {afterCard}
      {fullscreen && fullscreenOpen && (
        <ComposerFullscreen
          value={value}
          onValueChange={onValueChange}
          onSubmit={onSubmit}
          onClose={closeFullscreen}
          sendKey={sendKey}
          onPaste={onPaste}
          submitLabel={fullscreen.submitLabel}
          submitDisabled={fullscreen.submitDisabled || disabled}
          placeholder={placeholder}
        />
      )}
      {notice && (
        <div className="mt-1.5 px-1 text-label text-warn-ink" role="status">
          {notice}
        </div>
      )}
      {!compact && (
        <div
          data-composer-hint=""
          className="mt-1.5 flex items-center justify-between gap-3 px-1 text-label text-ink-faint max-md:hidden"
        >
          <span className="min-w-0 truncate">{hintLeft}</span>
          <span className="shrink-0">{hintRight}</span>
        </div>
      )}
    </div>
  );
}

/** 排队列表：卡片正上方一组弱化行，每行 = 时钟 · 文本（截断）· 行尾动作；可选顶部状态行与就地编辑。 */
function ComposerQueueList({ items, header }: { items: ComposerQueueItem[]; header?: ReactNode }) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  // 正在编辑的那条已经被发出 / 取消：编辑态随之失效（渲染时判定，不用 effect 清）。
  const active = editing && items.some((i) => i.id === editing.id) ? editing : null;
  return (
    <div
      data-composer-queue=""
      className="mb-1.5 rounded-card border border-line bg-surface p-1"
    >
      {header}
      <ul aria-label="排队中的消息" className="space-y-0.5">
        {items.map((item) =>
          active?.id === item.id && item.onEdit ? (
            <li key={item.id} data-composer-queue-item={item.id} data-composer-queue-editing="" className="rounded-field p-1">
              <QueueItemEditor
                value={active.draft}
                onChange={(draft) => setEditing({ id: item.id, draft })}
                onCancel={() => setEditing(null)}
                onSave={() => {
                  if (!active.draft.trim()) return;
                  item.onEdit?.(active.draft);
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li
              key={item.id}
              data-composer-queue-item={item.id}
              className="flex min-h-8 items-center gap-2 rounded-field pl-2 pr-0.5 text-ui max-md:min-h-11"
            >
              <Icon icon={Clock3} size="sm" className="shrink-0 text-ink-faint" />
              <span className="shrink-0 text-label text-ink-faint">{item.label ?? "排队中"}</span>
              <span className="min-w-0 flex-1 truncate text-ink" title={item.text}>
                {item.text.replace(/\s+/g, " ").trim()}
                {item.meta && <span className="ml-1.5 text-label text-ink-faint">{item.meta}</span>}
              </span>
              {item.onEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-composer-queue-edit=""
                  aria-label={`编辑排队消息：${item.text.slice(0, 20)}`}
                  onClick={() => setEditing({ id: item.id, draft: item.text })}
                  className="shrink-0"
                >
                  编辑
                </Button>
              )}
              {item.actions.map((action) => (
                <Button
                  key={action.label}
                  variant="ghost"
                  size="sm"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className={`shrink-0 ${action.tone === "danger" ? "hover:text-danger-ink" : ""}`}
                >
                  {action.label}
                </Button>
              ))}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function QueueItemEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={ref}
        data-composer-queue-editor=""
        aria-label="编辑排队消息"
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
        }}
        style={{ outline: "none" }}
        className="block w-full min-w-0 resize-none rounded-field border border-line-strong bg-surface px-2.5 py-1.5 text-ui text-ink-strong focus:border-accent-line max-h-40"
      />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={!value.trim()} data-composer-queue-save="">
          保存
        </Button>
      </div>
    </div>
  );
}
