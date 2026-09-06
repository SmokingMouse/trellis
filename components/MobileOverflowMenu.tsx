"use client";

import { useState, type ReactNode } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Drawer } from "@/components/ui/Drawer";
import { modeStyle } from "@/lib/mode-style";
import {
  blockedFamilySwitch,
  getProviderBadge,
  type ProviderId,
} from "@/lib/llm";
import { PALETTES } from "@/lib/themes";
import { useTheme } from "@/hooks/useTheme";
import { setDesktopModeOverride } from "@/hooks/useIsMobile";
import {
  downloadFile,
  exportJSON,
  exportMarkdown,
  safeFilename,
} from "@/lib/export";

type MobileOverflowMenuProps = {
  open: boolean;
  onClose: () => void;
  showAdmin: boolean;
  contextUsage: { percent: number } | null;
  onOpenContext: () => void;
};

const rowClass =
  "w-full min-h-11 px-4 flex items-center gap-3 text-left text-sm text-ink hover:bg-surface-muted transition-colors";
const statusRowClass =
  "w-full min-h-11 px-4 flex items-center gap-3 text-left text-sm text-ink-muted";

function MenuButton({
  target,
  icon,
  children,
  detail,
  onClick,
}: {
  target: string;
  icon: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-mobile-target={target}
      className={rowClass}
      onClick={onClick}
    >
      <span className="w-5 shrink-0 text-center text-base" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {detail && (
        <span className="max-w-[48%] truncate text-label text-ink-faint">
          {detail}
        </span>
      )}
    </button>
  );
}

function MenuLink({
  target,
  href,
  icon,
  children,
}: {
  target: string;
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a data-mobile-target={target} className={rowClass} href={href}>
      <span className="w-5 shrink-0 text-center text-base" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      <span className="text-ink-faint" aria-hidden>
        ›
      </span>
    </a>
  );
}

export function MobileOverflowMenu({
  open,
  onClose,
  showAdmin,
  contextUsage,
  onOpenContext,
}: MobileOverflowMenuProps) {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const notes = useSessionStore((s) => s.notes);
  const provider = useSessionStore((s) => s.provider);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);
  const setProvider = useSessionStore((s) => s.setProvider);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setMobileTreePanelOpen = useSessionStore(
    (s) => s.setMobileTreePanelOpen,
  );
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const setWorkspaceFilesOpen = useSessionStore(
    (s) => s.setWorkspaceFilesOpen,
  );
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const bookmarkCount = useSessionStore((s) => s.bookmarksTotal);
  const setBookmarksOpen = useSessionStore((s) => s.setBookmarksOpen);
  const { mode, palette, setMode, setPalette } = useTheme();
  const [exportOpen, setExportOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  const act = (fn: () => void) => {
    onClose();
    fn();
  };

  const exportCurrent = (format: "markdown" | "json") => {
    if (!session) return;
    const allNodes = Object.values(nodes);
    if (format === "markdown") {
      downloadFile(
        `${safeFilename(session.title)}.md`,
        exportMarkdown(session, allNodes),
        "text/markdown",
      );
    } else {
      downloadFile(
        `${safeFilename(session.title)}.trellis.json`,
        exportJSON(session, allNodes),
        "application/json",
      );
    }
    onClose();
  };

  const currentProvider =
    providerCatalog.find((candidate) => candidate.id === provider) ??
    providerCatalog[0];
  const currentMode = session ? modeStyle(session.mode).label : null;

  return (
    <Drawer open={open} onClose={onClose} widthClassName="sm:w-[380px]">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="更多功能"
        data-mobile-overflow-menu
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-12 shrink-0 items-center border-b border-line px-4">
          <h2 className="flex-1 text-sm font-semibold text-ink-strong">
            更多功能
          </h2>
          <button
            type="button"
            data-mobile-target="overflow-close"
            onClick={onClose}
            className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted"
            aria-label="关闭更多功能"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-line-faint overflow-y-auto overscroll-contain py-1">
          <MenuButton
            target="overflow-search"
            icon="⌕"
            onClick={() => act(() => setSearchOpen(true))}
          >
            搜索
          </MenuButton>

          <MenuButton
            target="overflow-bookmarks"
            icon="🔖"
            onClick={() => act(() => setBookmarksOpen(true))}
          >
            稍后再读 ({bookmarkCount})
          </MenuButton>

          {session && (
            <>
              <MenuButton
                target="overflow-tree"
                icon="⑂"
                onClick={() =>
                  act(() => {
                    setViewMode("linear");
                    setMobileTreePanelOpen(true);
                  })
                }
              >
                思维树
              </MenuButton>
              <MenuButton
                target="overflow-canvas"
                icon="🗺"
                onClick={() => act(() => setViewMode("canvas"))}
              >
                画布
              </MenuButton>
              {session.workspacePath && (
                <MenuButton
                  target="overflow-workspace-files"
                  icon="▣"
                  onClick={() => act(() => setWorkspaceFilesOpen(true))}
                >
                  工作区文件
                </MenuButton>
              )}
              <MenuButton
                target="overflow-notes"
                icon="▤"
                detail={notes.length > 0 ? `${notes.length} 条` : undefined}
                onClick={() => act(() => setNotesOpen(true))}
              >
                笔记
              </MenuButton>
              <MenuButton
                target="overflow-export"
                icon="⇩"
                detail={exportOpen ? "收起" : "Markdown / JSON"}
                onClick={() => setExportOpen((value) => !value)}
              >
                导出
              </MenuButton>
              {exportOpen && (
                <div className="bg-surface-muted/40 px-3 py-1">
                  <button
                    type="button"
                    data-mobile-target="overflow-export-markdown"
                    className={`${rowClass} rounded-md`}
                    onClick={() => exportCurrent("markdown")}
                  >
                    导出 Markdown
                  </button>
                  <button
                    type="button"
                    data-mobile-target="overflow-export-json"
                    className={`${rowClass} rounded-md`}
                    onClick={() => exportCurrent("json")}
                  >
                    导出 JSON
                  </button>
                </div>
              )}
              <div
                data-mobile-target="overflow-mode"
                className={statusRowClass}
                role="status"
              >
                <span className="w-5 shrink-0 text-center text-base" aria-hidden>
                  ◈
                </span>
                <span className="flex-1">模式</span>
                <span className="truncate text-label text-ink-faint">
                  {currentMode}
                  {session.workspacePath
                    ? ` · ${session.workspacePath.split("/").filter(Boolean).pop()}`
                    : ""}
                </span>
              </div>
              {contextUsage && (
                <MenuButton
                  target="overflow-context"
                  icon="🧠"
                  detail={`${contextUsage.percent < 10 ? contextUsage.percent.toFixed(1) : Math.round(contextUsage.percent)}%`}
                  onClick={() => act(onOpenContext)}
                >
                  上下文占用
                </MenuButton>
              )}
            </>
          )}

          <MenuButton
            target="overflow-models"
            icon="◆"
            detail={currentProvider?.shortLabel ?? provider}
            onClick={() => setModelsOpen((value) => !value)}
          >
            模型
          </MenuButton>
          {modelsOpen && (
            <div className="bg-surface-muted/40 px-3 py-1">
              {providerCatalog.map((candidate) => {
                const disabled =
                  candidate.hasKey === false ||
                  Boolean(
                    session && blockedFamilySwitch(provider, candidate.id),
                  );
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    data-mobile-target="overflow-model-option"
                    disabled={disabled}
                    className={`${rowClass} rounded-md disabled:cursor-not-allowed disabled:opacity-40`}
                    onClick={() => {
                      setProvider(candidate.id as ProviderId);
                      onClose();
                    }}
                  >
                    <span className="text-nano text-ink-faint">
                      [{getProviderBadge(candidate.id)}]
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.shortLabel}
                    </span>
                    {candidate.id === provider && <span aria-hidden>✓</span>}
                  </button>
                );
              })}
              <a
                href="/settings/models"
                data-mobile-target="overflow-model-settings"
                className={`${rowClass} rounded-md text-ink-muted`}
              >
                管理模型…
              </a>
            </div>
          )}

          <MenuButton
            target="overflow-theme"
            icon="◐"
            detail={themeOpen ? "收起" : "主题与外观"}
            onClick={() => setThemeOpen((value) => !value)}
          >
            主题
          </MenuButton>
          {themeOpen && (
            <div className="bg-surface-muted/40 px-3 py-2">
              <div className="grid grid-cols-3 gap-1">
                {(["light", "dark", "system"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-mobile-target="overflow-theme-mode"
                    onClick={() => setMode(value)}
                    className={`min-h-11 rounded-md px-2 text-ui ${
                      mode === value
                        ? "bg-accent-muted font-medium text-accent-ink"
                        : "bg-surface text-ink-muted"
                    }`}
                  >
                    {value === "light"
                      ? "浅色"
                      : value === "dark"
                        ? "深色"
                        : "系统"}
                  </button>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {PALETTES.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    data-mobile-target="overflow-theme-palette"
                    onClick={() => setPalette(candidate.id)}
                    className={`min-h-11 rounded-md px-3 text-left text-ui ${
                      palette === candidate.id
                        ? "bg-accent-muted text-accent-ink"
                        : "bg-surface text-ink-muted"
                    }`}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <MenuLink target="overflow-tasks" href="/settings/tasks" icon="◷">
            任务
          </MenuLink>
          <MenuLink target="overflow-settings" href="/settings" icon="⚙">
            设置
          </MenuLink>
          {showAdmin && (
            <MenuLink target="overflow-admin" href="/admin" icon="♜">
              管理后台
            </MenuLink>
          )}
          <MenuButton
            target="overflow-desktop-mode"
            icon="▰"
            onClick={() => {
              setDesktopModeOverride(true);
              window.location.reload();
            }}
          >
            转桌面版
          </MenuButton>
        </div>
      </section>
    </Drawer>
  );
}
