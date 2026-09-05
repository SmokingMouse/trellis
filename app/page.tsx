"use client";
import { useEffect, useRef } from "react";
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
import { TaskToast } from "@/components/TaskToast";
import { AbortToast } from "@/components/AbortToast";
import { StreamAlertToast } from "@/components/StreamAlertToast";
import { NotesDrawer } from "@/components/NotesDrawer";
import { TerminalPanel } from "@/components/TerminalPanel";
import { WorkspaceFilesDrawer } from "@/components/WorkspaceFilesDrawer";
import { SearchModal } from "@/components/SearchModal";
import { FilePreview } from "@/components/FilePreview";
import { KeyboardHelp } from "@/components/KeyboardHelp";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEscapeAbort } from "@/hooks/useEscapeAbort";
import { useUnreadNavigation } from "@/hooks/useUnreadNavigation";
import { useNodeKeyboardNav } from "@/hooks/useNodeKeyboardNav";
import { useReconnectStreams } from "@/hooks/useReconnectStreams";
import { useRunPolling } from "@/hooks/useRunPolling";
import { useCliSyncEvents } from "@/hooks/useCliSyncEvents";

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

  // S88 深链：/?session=<sid>&node=<nid>。任务页的运行历史点进来就走这条 ——
  // 任务层因此一行渲染代码都不用写，用户看到的和自己手动提问完全一样。
  // hydrate 之后再切，否则 loadSession 会被 hydrate 的结果覆盖掉。
  // 用 location 而不是 useSearchParams：后者会逼出 Suspense 边界要求（build 时
  // 才炸），而深链本就是纯客户端行为，没有 SSR 语义可言。
  // S117: 走 previewSession 而不是裸 loadSession —— 后者只换画面不占 tab 位，
  // 深链到任务会话时 tab 条/侧栏还高亮着 hydrate 选的上一个会话，画面与
  // 导航指向两个地方（「跳转目标特别奇怪」的主因之一）。
  const previewDeepSession = useSessionStore((s) => s.previewSession);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const deepLinkedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const deepSession = q.get("session");
    const deepNode = q.get("node");
    if (!deepSession) return;
    // 只跳一次 —— 用户在页面里点别的会话之后不该被 URL 拽回来。
    if (deepLinkedRef.current === deepSession) return;
    deepLinkedRef.current = deepSession;
    void previewDeepSession(deepSession).then(() => {
      if (deepNode) setActiveNode(deepNode);
    });
  }, [hydrated, previewDeepSession, setActiveNode]);

  // 注：--trellis-sb 由 SessionSidebar 发布（宽度可拖拽后归它所有，
  // 这里再按常量发一份就会打架）。

  // #7: mobile lands on the linear thread (the standard phone chat flow) for
  // every mode whenever the user arrives on a (different) session. They can
  // still switch to the canvas; we don't force them back.
  const sessionId = session?.id;
  useEffect(() => {
    if (isMobile && sessionId) setViewMode("linear");
  }, [isMobile, sessionId, setViewMode]);

  if (!hydrated || isMobile === null) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-ink-faint text-sm">
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
        <div className="fixed top-12 md:top-[5.25rem] inset-x-0 z-40 bg-warn-muted border-b border-warn-line px-4 py-2 text-xs text-warn-ink">
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
            className="fixed top-[60px] md:top-[108px] right-3 z-30 px-3 py-2 rounded-full bg-surface border border-line shadow-raise text-xs font-medium text-ink hover:bg-surface-muted active:scale-95 transition-transform"
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
      {/* S88：任务执行完成 / 失败的站内提醒（自带 SSE 订阅）。 */}
      <TaskToast />
      <AbortToast />
      <StreamAlertToast />
      {/* S1 P1：工作区终端。自己判断有没有 workspace（chat 会话直接返回 null），
          所以不在这里加条件 —— 它还要负责在没打开时渲染右下角那个「▲ 终端」把手。 */}
      {session && <TerminalPanel />}
      <NotesDrawer />
      <WorkspaceFilesDrawer />
      <SearchModal />
      <FilePreview />
      <KeyboardHelp />
    </>
  );
}
