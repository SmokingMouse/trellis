"use client";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Icon, IconButton, Modal } from "@/components/ui";
import { DiagramCanvas, type DiagramBackground, type DiagramSource } from "./DiagramCanvas";

// 代码块图表的「全屏查看」：铺满视口的弹窗 + 可缩放画布（交互见 DiagramCanvas）。
export function DiagramViewer({
  title,
  source,
  background,
  actions,
  onClose,
}: {
  title: string;
  source: DiagramSource;
  background?: DiagramBackground;
  /** 标题栏右侧的额外动作（复制源码 / 下载 / 衬底） */
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} size="full" title={title} panelClassName="flex flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink-strong">{title}</span>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
        <IconButton size="sm" label="关闭" shortcut="Esc" onClick={onClose}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>
      <DiagramCanvas
        source={source}
        background={background}
        label={title}
        autoFocus
        className="min-h-0 flex-1"
      />
    </Modal>
  );
}
