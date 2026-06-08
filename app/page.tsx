"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { QuestionInput } from "@/components/QuestionInput";
import { Canvas } from "@/components/Canvas";
import { Header } from "@/components/Header";
import { NodeFullView } from "@/components/NodeFullView";
import { Outline } from "@/components/Outline";
import { DoneToast } from "@/components/DoneToast";
import { NotesDrawer } from "@/components/NotesDrawer";
import { SearchModal } from "@/components/SearchModal";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEscapeAbort } from "@/hooks/useEscapeAbort";
import { useUnreadNavigation } from "@/hooks/useUnreadNavigation";
import { useNodeKeyboardNav } from "@/hooks/useNodeKeyboardNav";
import { useReconnectStreams } from "@/hooks/useReconnectStreams";

export default function Home() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const hydrated = useSessionStore((s) => s.hydrated);
  const session = useSessionStore((s) => s.session);
  const hydrateError = useSessionStore((s) => s.hydrateError);
  const fullScreen = useSessionStore((s) => s.fullScreen);
  const setFullScreen = useSessionStore((s) => s.setFullScreen);
  const isMobile = useIsMobile();
  useEscapeAbort();
  useUnreadNavigation();
  useNodeKeyboardNav();
  useReconnectStreams();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Mobile default → Layer 3 (fullscreen). Re-applies whenever the user lands
  // on a (different) session on a touch device. They can still back out to
  // canvas; we don't force them back in.
  const sessionId = session?.id;
  useEffect(() => {
    if (isMobile && sessionId) setFullScreen(true);
  }, [isMobile, sessionId, setFullScreen]);

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
      {hydrateError && (
        <div className="fixed top-12 inset-x-0 z-40 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-xs text-amber-900 dark:text-amber-200">
          ⚠️ 本地存储不可用：{hydrateError}。可以继续问答，但刷新会丢失历史。
        </div>
      )}
      {!session && <QuestionInput />}
      {session && fullScreen && <NodeFullView />}
      {session && !fullScreen && (
        <Canvas
          onNodeFocus={isMobile ? () => setFullScreen(true) : undefined}
        />
      )}
      {/* B1: mobile outline drawer — mounted top-level so it survives
          fullscreen (where Canvas + its rail Outline unmount). Desktop hides
          it (md:hidden) since the rail Outline inside Canvas covers desktop. */}
      {session && <Outline variant="drawer" />}
      <DoneToast />
      <NotesDrawer />
      <SearchModal />
    </>
  );
}
