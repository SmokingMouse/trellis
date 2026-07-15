"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { QuestionInput } from "@/components/QuestionInput";
import { Canvas } from "@/components/Canvas";
import { Header } from "@/components/Header";
import { SessionTabs } from "@/components/SessionTabs";
import { SessionSidebar } from "@/components/SessionSidebar";
import { LinearThreadView } from "@/components/LinearThreadView";
import { NewQuestionPicker } from "@/components/NewQuestionPicker";
import { Outline } from "@/components/Outline";
import { DoneToast } from "@/components/DoneToast";
import { AbortToast } from "@/components/AbortToast";
import { StreamAlertToast } from "@/components/StreamAlertToast";
import { NotesDrawer } from "@/components/NotesDrawer";
import { WorkspaceFilesDrawer } from "@/components/WorkspaceFilesDrawer";
import { SearchModal } from "@/components/SearchModal";
import { FilePreview } from "@/components/FilePreview";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEscapeAbort } from "@/hooks/useEscapeAbort";
import { useUnreadNavigation } from "@/hooks/useUnreadNavigation";
import { useNodeKeyboardNav } from "@/hooks/useNodeKeyboardNav";
import { useReconnectStreams } from "@/hooks/useReconnectStreams";
import { useRunPolling } from "@/hooks/useRunPolling";
import { useCliSyncEvents } from "@/hooks/useCliSyncEvents";
import { SIDEBAR_W } from "@/lib/workbench-layout";

export default function Home() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const hydrated = useSessionStore((s) => s.hydrated);
  const session = useSessionStore((s) => s.session);
  const hydrateError = useSessionStore((s) => s.hydrateError);
  const viewMode = useSessionStore((s) => s.viewMode);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  // Remote 新话题 triggers (Header B3 prompt, /clear from any composer) —
  // consumed here instead of inside AddNodeFAB so the picker opens in the
  // linear view too, where the canvas FAB is unmounted.
  const composeRootOpen = useSessionStore((s) => s.composeRootOpen);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const isMobile = useIsMobile();
  useEscapeAbort();
  useUnreadNavigation();
  useNodeKeyboardNav();
  useReconnectStreams();
  useCliSyncEvents();
  // Wave 4: one app-level /api/runs poll feeds running + unread badges to
  // both the tab strip and the sidebar (no per-component intervals).
  useRunPolling();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Wave 4: publish the effective left offset (sidebar width on desktop when
  // open, else 0) as a CSS variable so every full-bleed surface (Canvas /
  // LinearThreadView / QuestionInput) and the Outline rail can shift right by
  // it without each re-deriving the breakpoint. Mobile keeps offset 0 — the
  // sidebar is a non-permanent overlay there.
  useEffect(() => {
    const offset = !isMobile && sidebarOpen ? SIDEBAR_W : 0;
    document.documentElement.style.setProperty("--trellis-sb", `${offset}px`);
  }, [isMobile, sidebarOpen]);

  // #7: mobile lands on the linear thread (the standard phone chat flow) for
  // every mode whenever the user arrives on a (different) session. They can
  // still switch to the canvas; we don't force them back.
  const sessionId = session?.id;
  useEffect(() => {
    if (isMobile && sessionId) setViewMode("linear");
  }, [isMobile, sessionId, setViewMode]);

  if (!hydrated || isMobile === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-400 dark:text-stone-500 text-sm">
        加载中…
      </div>
    );
  }

  return (
    <>
      <Header />
      <SessionSidebar />
      <SessionTabs />
      {hydrateError && (
        <div className="fixed top-[5.25rem] inset-x-0 z-40 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-xs text-amber-900 dark:text-amber-200">
          ⚠️ 本地存储不可用：{hydrateError}。可以继续问答，但刷新会丢失历史。
        </div>
      )}
      {!session && <QuestionInput />}
      {session && viewMode === "linear" && <LinearThreadView />}
      {session && viewMode === "canvas" && (
        <>
          <Canvas
            onNodeFocus={isMobile ? () => setViewMode("linear") : undefined}
          />
          <button
            type="button"
            onClick={() => setViewMode("linear")}
            className="fixed top-[108px] right-3 z-30 px-3 py-2 rounded-full bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 shadow-md text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800 active:scale-95 transition-transform"
            title="切换到线性 thread"
          >
            线性
          </button>
        </>
      )}
      {/* B1: mobile outline drawer — mounted top-level so it survives the
          linear view (where Canvas + its rail Outline unmount). Desktop hides
          it (md:hidden) since the rail Outline inside Canvas covers desktop. */}
      {session && <Outline variant="drawer" />}
      {session && composeRootOpen && (
        <NewQuestionPicker onClose={() => setComposeRootOpen(false)} />
      )}
      <DoneToast />
      <AbortToast />
      <StreamAlertToast />
      <NotesDrawer />
      <WorkspaceFilesDrawer />
      <SearchModal />
      <FilePreview />
    </>
  );
}
