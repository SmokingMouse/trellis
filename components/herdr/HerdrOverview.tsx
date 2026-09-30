"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  LayoutGrid,
  MessageSquare,
  Search,
  SquareTerminal,
} from "lucide-react";
import {
  Button,
  Icon,
  Input,
  Kbd,
  Spinner,
  StatusDot,
  cn,
  toast,
} from "@/components/ui";
import { HerdrInteractionCard, type HerdrScreenPromptSummary } from "@/components/HerdrInteractionCard";
import { HerdrPaneMenu } from "./HerdrPaneMenu";
import { openHerdrConsolePane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  groupHerdrLanes,
  herdrApproval,
  herdrAttentionKind,
  type HerdrConsolePane,
} from "@/lib/herdr-console";
import { herdrPanePrompt } from "@/lib/herdr-ui";
import { cachedHerdrPeek, sendHerdrInput, sendHerdrKeys } from "@/lib/herdr-actions";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

const IDLE_VISIBLE = 5;

function ago(at: number | null, now: number): string | null {
  return at == null ? null : formatRelativeTimeShort(at, now);
}

const KIND_LABEL = { approval: "要执行", question: "提问", terminal: "终端在等你" } as const;

// /herdr 总览：工作台主区的一个视图（和首页同级），三道泳道：需要你 / 在跑 / 空闲。
// 原型 docs/ui-redesign/mockups/05-herdr.html 第 1–2 步。
export function HerdrOverview({ isMobile }: { isMobile: boolean }) {
  const hc = useHerdrConsole();
  const lanes = groupHerdrLanes(hc.panes);
  const [showMore, setShowMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const workspaces = new Set(hc.panes.filter((p) => p.lane !== "off").map((p) => p.workspaceId)).size;
  const livePanes = hc.panes.filter((p) => p.lane !== "off").length;
  const idleShown = showMore ? lanes.idle : lanes.idle.slice(0, IDLE_VISIBLE);
  const hiddenIdle = Math.max(0, lanes.idle.length - IDLE_VISIBLE);
  const foldable = hiddenIdle + lanes.off.length + lanes.shell.length;
  const menu = (pane: HerdrConsolePane, className?: string) => (
    <HerdrPaneMenu pane={pane} readOnly={hc.readOnly} available={hc.available} className={className} />
  );

  return (
    <main
      data-herdr-overview
      className="fixed inset-x-0 bottom-0 overflow-y-auto overscroll-contain bg-surface-canvas"
      style={
        isMobile
          ? { top: "var(--trellis-header-h)", paddingBottom: "var(--safe-bottom)" }
          : { top: "calc(3rem + 2.25rem)", left: "var(--trellis-sb, 0px)", right: "var(--trellis-herdr-dw, 0px)" }
      }
    >
      <div className="mx-auto w-full max-w-[1040px] px-6 pb-28 pt-5 max-md:px-4">
        <header className="mb-4 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <h2 className="flex items-center gap-2 text-title font-semibold text-ink-strong">
            <Icon icon={LayoutGrid} className="text-ink-muted" />
            Herdr
          </h2>
          <div className="flex gap-3.5 text-label text-ink-muted" data-herdr-summary>
            <span><b className="mr-0.5 font-semibold text-ink-strong tabular-nums">{lanes.need.length}</b>需要你</span>
            <span><b className="mr-0.5 font-semibold text-ink-strong tabular-nums">{lanes.run.length}</b>在跑</span>
            <span><b className="mr-0.5 font-semibold text-ink-strong tabular-nums">{lanes.idle.length}</b>空闲</span>
          </div>
          <div className="ml-auto flex items-center gap-3 text-label text-ink-faint">
            <span className="inline-flex items-center gap-1.5" data-herdr-connection>
              {hc.available ? (
                <>
                  <StatusDot tone={hc.readOnly ? "warn" : "positive"} />
                  {hc.readOnly ? "只读（协议不符）" : "已连接"} · {workspaces} 工作区 · {livePanes} 窗格
                </>
              ) : (
                <>
                  <StatusDot tone="idle" />
                  {hc.unavailableText}
                </>
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => useHerdrConsoleStore.getState().setPaletteOpen(true)}
              className="max-md:hidden"
            >
              <Icon icon={Search} size="sm" />
              跳到窗格
              <Kbd>⌥K</Kbd>
            </Button>
          </div>
        </header>

        {!hc.available && !hc.loading && (
          <div data-herdr-unavailable className="mb-6 rounded-card border border-line bg-surface px-4 py-3 text-ui text-ink-muted">
            <div className="font-medium text-ink">{hc.unavailableText}</div>
            <p className="mt-1 text-label text-ink-faint">
              已同步的 Herdr 会话仍可在侧栏里阅读。启动 Herdr 后这里会自动恢复。
            </p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => void refreshHerdrFleet()}>
              重新连接
            </Button>
          </div>
        )}

        {lanes.need.length > 0 && (
          <section className="mb-6" data-herdr-lane="need">
            <LaneHeader icon={<Icon icon={CircleAlert} size="sm" className="text-warn" />} label="需要你" count={lanes.need.length} />
            {lanes.need.map((pane) => (
              <NeedCard key={pane.key} pane={pane} now={now} menu={menu(pane)} readOnly={hc.readOnly} />
            ))}
          </section>
        )}

        <section className="mb-6" data-herdr-lane="run">
          <LaneHeader
            icon={<Spinner size="sm" label={null} />}
            label="在跑"
            count={lanes.run.length}
            hint={lanes.run.length ? "悬停看最后几行输出" : undefined}
          />
          {lanes.run.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-4 py-4 text-label text-ink-faint">
              没有在跑的窗格
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
              {lanes.run.map((pane) => (
                <RunCard key={pane.key} pane={pane} now={now} menu={menu(pane, "opacity-0 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100")} />
              ))}
            </div>
          )}
        </section>

        <section data-herdr-lane="idle">
          <LaneHeader icon={<StatusDot tone="idle" />} label="空闲" count={lanes.idle.length} hint="按最近活动" />
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {idleShown.map((pane) => (
              <IdleRow key={pane.key} pane={pane} now={now} menu={menu(pane, "opacity-0 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100")} />
            ))}
            {showMore &&
              lanes.off.map((pane) => (
                <IdleRow key={pane.key} pane={pane} now={now} menu={menu(pane, "opacity-0 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100")} />
              ))}
            {showMore &&
              lanes.shell.map((pane) => (
                <IdleRow key={pane.key} pane={pane} now={now} menu={menu(pane, "opacity-0 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100")} />
              ))}
            {idleShown.length === 0 && !showMore && (
              <div className="px-3.5 py-2.5 text-label text-ink-faint">没有空闲的窗格</div>
            )}
            {foldable > 0 && (
              <button
                type="button"
                data-herdr-fold
                onClick={() => setShowMore((v) => !v)}
                className="flex h-8 w-full items-center gap-1.5 border-t border-line-faint px-3.5 text-label text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink max-md:h-11"
              >
                <Icon icon={showMore ? ChevronUp : ChevronDown} size="sm" />
                {showMore
                  ? "收起"
                  : [
                      hiddenIdle ? `还有 ${hiddenIdle} 个空闲` : null,
                      lanes.off.length ? `${lanes.off.length} 个离线` : null,
                      lanes.shell.length ? `${lanes.shell.length} 个纯 shell` : null,
                    ].filter(Boolean).join(" · ")}
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function LaneHeader({ icon, label, count, hint }: { icon: React.ReactNode; label: string; count: number; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-label font-medium text-ink-muted">
      {icon}
      {label}
      <span className="font-normal text-ink-faint tabular-nums">{count}</span>
      {hint && <span className="ml-auto font-normal text-ink-faint">{hint}</span>}
    </div>
  );
}

function NeedCard({ pane, now, menu, readOnly }: { pane: HerdrConsolePane; now: number; menu: React.ReactNode; readOnly: boolean }) {
  // hook / transcript 都没给结构化提示时，用卡片读屏认出的类型（提问 / 要执行 Bash）
  const [screenPrompt, setScreenPrompt] = useState<HerdrScreenPromptSummary | null>(null);
  const hookKind = herdrAttentionKind(pane);
  const kind = hookKind === "terminal" && screenPrompt ? (screenPrompt.kind === "approval" ? "approval" : "question") : hookKind;
  const approvalTool = herdrApproval(herdrPanePrompt(pane.view)?.prompt)?.tool ?? screenPrompt?.tool ?? "";
  const waited = ago(pane.activityAt, now);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const where = `${pane.workspaceLabel} · ${pane.tabLabel}`;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (replyOpen) inputRef.current?.focus();
  }, [replyOpen]);

  // 回复 = 拒绝当前待确认项（Esc）+ 把这段话发进窗格：Esc 打断后窗格回到空闲，
  // Herdr 输入队列在空闲时自动送达（和会话页 HerdrComposer 同一条队列）。
  const send = async () => {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendHerdrKeys(pane.paneId, ["Escape"]);
      const result = await sendHerdrInput(pane.paneId, text);
      toast.success(result.status === "queued" ? `已排队，${where} 空闲后自动发送` : `已发进 ${where}`);
      setReply("");
      setReplyOpen(false);
      void refreshHerdrFleet();
    } catch (error) {
      toast.error("发送失败", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <article
      data-herdr-need-card={pane.paneId}
      className="mb-2.5 rounded-card border border-warn-line bg-surface"
    >
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-2.5">
        <button
          type="button"
          onClick={() => openHerdrConsolePane(pane)}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          title={pane.sessionId ? "进会话" : "打开终端"}
        >
          <StatusDot tone="warn" className="ring-3 ring-warn-muted" />
          <span className="min-w-0 truncate text-ui font-semibold text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-3">
            {pane.title}
          </span>
          <span className="shrink-0 whitespace-nowrap text-label text-ink-faint max-md:hidden">
            {where} · {kind === "approval" ? `${KIND_LABEL.approval} ${approvalTool}`.trim() : KIND_LABEL[kind]}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-label text-ink-faint">
            {waited && <span>{waited === "刚刚" ? "刚刚" : `等了 ${waited}`}</span>}
            <span className="inline-flex items-center gap-0.5">
              {pane.sessionId ? "进会话" : "看终端"}
              <Icon icon={ChevronRight} size="sm" />
            </span>
          </span>
        </button>
        {menu}
      </div>
      {pane.view && (
        <HerdrInteractionCard
          pane={pane.view}
          embedded
          terminalFallback
          onScreenPrompt={setScreenPrompt}
          footer={
            readOnly ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-herdr-reply
                onClick={() => setReplyOpen((v) => !v)}
                className="min-h-11 sm:min-h-8"
              >
                <Icon icon={MessageSquare} size="sm" />
                {kind === "question" ? "其他（打字）" : "回复…"}
              </Button>
            )
          }
        />
      )}
      {replyOpen && (
        <form
          className="flex gap-1.5 px-3.5 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            ref={inputRef}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={`告诉它换个做法，Enter 发进 ${where}`}
            aria-label={`回复 ${where}`}
            className="flex-1"
            disabled={sending}
          />
          <Button type="submit" variant="primary" size="sm" disabled={!reply.trim()} loading={sending}>
            发送
          </Button>
        </form>
      )}
    </article>
  );
}

function RunCard({ pane, now, menu }: { pane: HerdrConsolePane; now: number; menu: React.ReactNode }) {
  const [peek, setPeek] = useState<string | null>(null);
  const [peekOn, setPeekOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = ago(pane.activityAt, now);
  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    // 悬停 450ms 才读屏；客户端 5 秒缓存 + 服务端 1 秒缓存，扫过网格不会打出一串 socket 读。
    timer.current = setTimeout(() => {
      const cached = cachedHerdrPeek(pane.paneId, 8);
      if (cached.text != null) setPeek(cached.text);
      setPeekOn(true);
      void cached.load().then(setPeek).catch(() => setPeek((v) => v ?? "读屏暂不可用"));
    }, 450);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setPeekOn(false);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <article
      role="button"
      tabIndex={0}
      data-herdr-run-card={pane.paneId}
      onClick={() => openHerdrConsolePane(pane)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openHerdrConsolePane(pane);
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      className="group relative cursor-pointer rounded-card border border-line bg-surface px-3 pb-2 pt-2.5 transition-colors hover:border-line-strong"
    >
      <div className="mb-1 flex items-center gap-1.5 text-label text-ink-faint">
        <span className="min-w-0 truncate">{pane.workspaceLabel} · {pane.tabLabel}</span>
        <span className="ml-auto" />
        {menu}
      </div>
      <div className="line-clamp-2 min-h-[2.9em] text-ui font-semibold leading-snug text-ink">{pane.title}</div>
      <div className="mt-1.5 truncate font-mono text-nano text-ink-muted">● {pane.lastTool ?? "Thinking…"}</div>
      <div className="mt-1.5 flex items-center gap-1.5 text-label text-ink-faint">
        <span>{pane.agentKind}</span>
        {last && (
          <>
            <span>·</span>
            <span title="最近一次活动">{last}</span>
          </>
        )}
        {pane.queued > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-ink-muted">
            <Icon icon={Clock} size="sm" />
            排队 {pane.queued}
          </span>
        )}
      </div>
      <pre
        aria-hidden={!peekOn}
        data-herdr-peek
        className={cn(
          "code-surface pointer-events-none absolute inset-x-0 top-[calc(100%+6px)] z-20 max-h-44 overflow-hidden whitespace-pre rounded-field border border-line px-3 py-2.5 font-mono text-nano leading-relaxed shadow-pop transition-opacity",
          peekOn ? "opacity-100" : "opacity-0",
        )}
      >
        {peek ?? "正在读取最后几行…"}
      </pre>
    </article>
  );
}

function IdleRow({ pane, now, menu }: { pane: HerdrConsolePane; now: number; menu: React.ReactNode }) {
  const off = pane.lane === "off";
  const shell = pane.lane === "shell";
  const last = off ? "已离线" : shell ? "shell" : ago(pane.activityAt, now);
  return (
    <div
      role="button"
      tabIndex={0}
      data-herdr-idle-row={pane.key}
      onClick={() => openHerdrConsolePane(pane)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openHerdrConsolePane(pane);
      }}
      className="group flex h-9 cursor-pointer items-center gap-2.5 border-t border-line-faint px-3.5 text-ui transition-colors first:border-t-0 hover:bg-surface-hover max-md:h-11"
    >
      {shell ? (
        <Icon icon={SquareTerminal} size="sm" className="text-ink-faint" />
      ) : (
        <StatusDot tone={off ? "neutral" : "idle"} />
      )}
      <span className="w-32 shrink-0 truncate text-label text-ink-faint max-md:w-20">
        {pane.workspaceLabel}
        {pane.tabLabel !== "t1" ? ` · ${pane.tabLabel}` : ""}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", off || shell ? "text-ink-faint" : "text-ink", shell && "font-mono text-label")}>
        {pane.title}
      </span>
      {last && <span className="shrink-0 text-label text-ink-faint">{last}</span>}
      {menu}
    </div>
  );
}
