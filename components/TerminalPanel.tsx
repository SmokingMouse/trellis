"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { IconButton } from "@/components/ui/IconButton";

// S1 P1（progress/project-workspace-layer.md）：工作区终端，IDE 式底部分栏。
//
// **终端是这个平台的一个接口，不是旁路**：iframe 指向同源的 `/term/…`，
// 跟页面和 API 走同一个域名、同一个端口、同一个 cookie 闸；本机和远程是
// 完全相同的一条路径，这里没有任何 isLocal 分支。转发发生在大门
// （server.ts 的 Bun.serve）里——Next 不能升级 WebSocket，所以大门必须在它前面。
//
// 每个终端 = 一个独立 tmux session = 一个独立 iframe（不是 tmux window）。
// 选 session 而非 window，是因为 tab 切换要归 trellis 管、不能让用户去学 ⌃b n。

const HEIGHT_KEY = "trellis-term-height";
const OPEN_KEY = "trellis-term-open"; // per-workspace：值是 workspace id 的数组
// 钉住 = 全局偏好（不是 per-workspace）：它是「我习惯哪种形态」，
// 不是「这个工作区怎么样」。默认 false = Quake 浮层。
const PIN_KEY = "trellis-term-pinned";
const MIN_H = 120;
const MAX_H = 720;
const DEFAULT_H = 260;

type Terminal = { session: string; index: number };

function loadHeight(): number {
  if (typeof window === "undefined") return DEFAULT_H;
  const n = Number(window.localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_H && n <= MAX_H ? n : DEFAULT_H;
}

function loadPinned(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PIN_KEY) === "1";
}

function loadOpenSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function TerminalPanel() {
  const session = useSessionStore((s) => s.session);
  const workspaceId = session?.workspaceId ?? null;

  const [openSet, setOpenSet] = useState<Set<string>>(loadOpenSet);
  const [pinned, setPinned] = useState<boolean>(loadPinned);
  const [height, setHeight] = useState<number>(loadHeight);
  // null = 还没拉过（加载中）。用它当加载态而不是单独一个 loading，
  // 是为了避免在 effect 体里同步 setState（react-hooks/set-state-in-effect）。
  const [terminals, setTerminals] = useState<Terminal[] | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const open = Boolean(workspaceId && openSet.has(workspaceId));

  const persistOpen = useCallback((next: Set<string>) => {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      /* 隐私模式：退化成只在本次会话内有效 */
    }
  }, []);

  const toggleOpen = useCallback(() => {
    if (!workspaceId) return;
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      persistOpen(next);
      return next;
    });
  }, [workspaceId, persistOpen]);

  const togglePin = useCallback(() => {
    setPinned((p) => {
      const next = !p;
      try {
        window.localStorage.setItem(PIN_KEY, next ? "1" : "0");
      } catch {
        /* 隐私模式：退化成只在本次会话内有效 */
      }
      return next;
    });
  }, []);

  // ⌃` 开关。**只能开、关不掉** —— 焦点在 iframe 里时键盘事件不冒泡到父文档
  // （S70 给 Excalidraw 建的 [data-keys-yield] 是同文档内方案，对 iframe 无效）。
  // 所以面板右上角必须有一个真的关闭按钮，那才是唯一可靠的关法。
  useEffect(() => {
    if (!workspaceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceId, toggleOpen]);

  // 把面板高度发布成 CSS 变量，让 LinearThreadView / Canvas 让出底部空间
  // （与 --trellis-sb 同一套模式：一个变量，多个消费者，不各自重算断点）。
  // 只有**钉住**态才让内容区让位。浮层态盖在内容之上、零常驻占用 ——
  // 这正是「更轻」的全部含义。
  useEffect(() => {
    const h = open && pinned ? height : 0;
    document.documentElement.style.setProperty("--trellis-term-h", `${h}px`);
    return () => {
      document.documentElement.style.setProperty("--trellis-term-h", "0px");
    };
  }, [open, height, pinned]);

  const addTerminal = useCallback(async () => {
    if (!workspaceId) return;
    const r = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    }).then((x) => x.json());
    if (r.error && !r.ready) {
      setError(r.error);
      return;
    }
    setReady(Boolean(r.ready));
    setCwd(r.cwd ?? null);
    // session 名是 `ws-<uuid>-<n>`，uuid 自带 `-`，所以序号只能从右边切最后一段。
    const idx = Number(String(r.session).split("-").pop());
    setTerminals((prev) => [...(prev ?? []), { session: r.session, index: idx }]);
    setActiveSession(r.session);
  }, [workspaceId]);

  // 拉终端列表 + ttyd 端口。只在面板真打开时才请求 —— GET 会懒启动 ttyd 进程，
  // 纯 chat 用户不该因为路过而多出一个常驻进程。
  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    fetch(`/api/terminals?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setReady(Boolean(d.ready));
        setCwd(d.cwd ?? null);
        setError(d.error ?? null);
        const list: Terminal[] = d.terminals ?? [];
        setTerminals(list);
        setActiveSession((cur) =>
          cur && list.some((t) => t.session === cur)
            ? cur
            : (list[0]?.session ?? null),
        );
        // **刻意不自动创建**。原来这里会在列表为空时自动开一个，理由是
        // 「别让用户对着空面板再点一次」—— 那个理由建立在「创建很便宜」上，
        // 而实测**新建一个终端要 588ms**（全新 tmux session 要跑一遍交互式
        // zsh；复用已有 session 只要 8ms）。于是形成一个恶性循环：叉掉终端 →
        // 切走再切回 → 列表为空 → 又自动建一个，每次重付 588ms，还在 tmux 里
        // 堆一地 session。创建必须是显式的。
      })
      .catch(() => {
        if (!cancelled) setError("拉取终端列表失败");
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, addTerminal]);

  const closeTerminal = useCallback(
    async (s: string) => {
      await fetch(`/api/terminals?session=${encodeURIComponent(s)}`, {
        method: "DELETE",
      });
      setTerminals((prev) => {
        const next = (prev ?? []).filter((t) => t.session !== s);
        setActiveSession((cur) =>
          cur === s ? (next[next.length - 1]?.session ?? null) : cur,
        );
        return next;
      });
    },
    [],
  );

  // 拖拽调高。鼠标可能划过 iframe，那会把 mousemove 吞掉 —— 拖拽期间给
  // iframe 盖一层 pointer-events 遮罩（下面 dragging 状态）。
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY)));
      setHeight(next);
    };
    const onUp = () => {
      setDragging(false);
      dragRef.current = null;
      setHeight((h) => {
        try {
          window.localStorage.setItem(HEIGHT_KEY, String(h));
        } catch {
          /* 忽略 */
        }
        return h;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // chat 会话没有 workspace，也就没有终端可言。
  if (!workspaceId) return null;

  if (!open) {
    return (
      <button
        onClick={toggleOpen}
        title="打开终端（⌃`）"
        className="hidden md:flex fixed bottom-[88px] right-4 z-40 items-center gap-1.5 h-7 px-2.5 rounded-full bg-surface/90 backdrop-blur border border-line shadow-raise text-label text-ink-muted hover:text-ink hover:bg-surface-muted"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 17l6-5-6-5M12 19h8" />
        </svg>
        <span className="text-nano opacity-70">⌃`</span>
      </button>
    );
  }

  // 两态共用同一份内容，只换外壳：
  //   float —— 悬在右下、圆角带阴影、四周透出对话；零常驻占用（默认）
  //   dock  —— 贴底通栏，内容区靠 --trellis-term-h 让位（同屏并排看）
  return (
    <div
      className={
        pinned
          ? "hidden md:flex fixed bottom-0 right-0 z-40 flex-col bg-surface-canvas border-t border-line"
          : "hidden md:flex fixed z-40 flex-col bg-surface-canvas border border-line rounded-lg shadow-overlay overflow-hidden"
      }
      style={
        pinned
          ? { left: "var(--trellis-sb, 0px)", height }
          : {
              // 浮层：右下角浮起，留出边距让对话从四周透出来。
              // 宽度封顶 880 且不越过侧栏，窄屏自动收窄。
              right: 16,
              // 抬到 composer 之上：盖住对话是 Quake 终端的常态（用完即走），
              // 但盖住输入框不行 —— 那是你收起终端后马上要用的东西。
              bottom: 88,
              height,
              width: "min(880px, calc(100vw - var(--trellis-sb, 0px) - 48px))",
            }
      }
    >
      {/* 顶边拖拽调高 */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height };
          setDragging(true);
        }}
        className={`absolute inset-x-0 h-2 cursor-row-resize ${pinned ? "-top-1" : "top-0"}`}
        aria-hidden
      />

      {/* 标题栏。**它必须常显** —— 焦点一旦进了 iframe，⌃` 和 Esc 都到不了
          父文档（S70 那套 [data-keys-yield] 对 iframe 无效），所以这一栏上的
          ✕ 是唯一可靠的关法。 */}
      <div className="shrink-0 flex items-center gap-1 h-8 px-2 border-b border-line-faint bg-surface-canvas">
        {(terminals ?? []).map((t) => (
          <div
            key={t.session}
            className={`group flex items-center gap-1 h-6 pl-2 pr-1 rounded-md text-label cursor-pointer ${
              t.session === activeSession
                ? "bg-surface-muted text-ink-strong"
                : "text-ink-muted hover:bg-surface-muted"
            }`}
            onClick={() => setActiveSession(t.session)}
            title={t.session}
          >
            <span>bash {t.index}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void closeTerminal(t.session);
              }}
              title="结束这个终端（kill-session，shell 状态会丢；只是不想看就用右上角收起）"
              aria-label="关闭终端"
              className="opacity-0 group-hover:opacity-100 px-1 rounded hover:bg-danger-muted hover:text-danger"
            >
              ✕
            </button>
          </div>
        ))}
        <IconButton label="新建终端" title="新建终端" size="sm" onClick={addTerminal}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </IconButton>
        <span className="ml-auto truncate text-nano text-ink-faint" title={cwd ?? ""}>
          {cwd}
        </span>
        <IconButton
          label={pinned ? "取消钉住（回浮层）" : "钉住（并排看）"}
          title={pinned ? "取消钉住 —— 回到浮层，用完即走" : "钉住 —— 变成底部分栏，与对话并排"}
          size="sm"
          onClick={togglePin}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {pinned ? (
              <>
                <path d="M4 20 L20 4" />
                <path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z" />
              </>
            ) : (
              <path d="M9 4h6l-1 6 4 3v2h-5v5l-1 2-1-2v-5H6v-2l4-3z" />
            )}
          </svg>
        </IconButton>
        <IconButton label="收起终端" title="收起终端（⌃`）" size="sm" onClick={toggleOpen}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </IconButton>
      </div>

      {/* 主体 */}
      <div className="flex-1 min-h-0 relative">
        {error && !ready ? (
          <div className="p-3 text-label text-danger">终端不可用：{error}</div>
        ) : terminals === null ? (
          <div className="p-3 text-label text-ink-faint italic">准备中…</div>
        ) : !ready || !activeSession ? (
          // 空态是个真入口，不是一句干瞪眼的「没有终端」—— 创建现在是显式的，
          // 那这里就得把「怎么创建」摆在手边。
          <div className="h-full flex flex-col items-center justify-center gap-2">
            <button
              onClick={addTerminal}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-ink-inverse text-label font-medium hover:opacity-90"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              新建终端
            </button>
            <div className="text-nano text-ink-faint">
              {cwd ?? ""}
            </div>
          </div>
        ) : (
          <>
            {/* 只挂载激活 tab 的 iframe。卸载会断开 ttyd 连接，但 tmux session
                仍活着、同名重连复用（实测：断开后 tmux ls 存活、重连创建时间
                不变），所以状态不丢，还省掉 N 个 iframe 常驻吃内存。 */}
            <iframe
              key={activeSession}
              // 同源 —— 大门（server.ts）把 /term/* 转发给 ttyd。本机与远程
              // 是同一个 URL，这里没有任何分支。
              src={`/term/?arg=${encodeURIComponent(activeSession)}&arg=-c&arg=${encodeURIComponent(cwd ?? "")}`}
              className="absolute inset-0 w-full h-full border-0"
              title={`终端 ${activeSession}`}
            />
            {/* 拖拽时盖住 iframe，否则鼠标一划进去 mousemove 就被它吞了 */}
            {dragging && <div className="absolute inset-0" aria-hidden />}
          </>
        )}
      </div>
    </div>
  );
}
