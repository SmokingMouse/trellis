"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Drawer as Vaul } from "vaul";
import { cn } from "./cn";
import { focusPanelIfIdle, restoreFocus, trapTabKey } from "./focus";
import { LayerContainerContext } from "./Layer";
import { SheetGrabber, SHEET_DRAWER_QUERY, useMediaQuery, useSheetTouchClaim } from "./sheet";

// 抽屉原语：桌面（≥sm）右侧面板 / 手机（<sm）底部 sheet。
// portal 到 body、z-50、role=dialog、Tab 循环、Esc、自动聚焦 / 归还焦点。
// 外部 API 不变：open 受控 + onClose；新增可选 preventDismiss。
//
// 外壳（scrim + aria-hidden）常驻挂载：mobile-verify 用
// `closest('[aria-hidden]').getAttribute('aria-hidden') === 'false'` 判断抽屉开着。
// 外壳用 react-dom 的 createPortal 自己挂，面板再用 Radix Portal 挂进外壳——
// 别给 Radix Portal 传 forceMount：Content 会继承它，关着的抽屉也常驻挂载
// （FocusScope / Esc 监听全在跑，页面加载时还会被自动聚焦）。
// 两种形态共用这套外壳，DOM 判定方式不变。
//
// 桌面：Radix Dialog，进 / 退场是 data-state 驱动的 CSS 动画（globals.css
// .ui-drawer），Radix Presence 等退场动画播完再卸载。
//
// 手机：vaul（Drawer.Root 内部就是同一份 Radix Dialog，modal={false} 同桌面）。
//   - detent 参照 Cindy：默认档 = 屏高 56%（下限 320px），上拉到 full = 屏高 - 64px；
//   - 跟手下拉，松手时露出高度 < 默认档 62% 就关（preventDismiss 时回弹原位）；
//   - 内容区滚到顶之后再下拉才拖 sheet（vaul 自带的 shouldDrag 判定）；可滚动区默认
//     touch-action:auto，浏览器一接管平移就发 pointercancel、vaul 收不到后续 move，
//     所以竖向手势该归 sheet 时（默认档 / 滚到顶再下拉）在第一个 touchmove 上 preventDefault；
//   - scrim 透明度跟随拖拽，落位走 --ease-spring / --dur-heavy（globals.css .ui-sheet）。
//   vaul 的 snap 模型是「整块面板高 = full，靠 translateY 露出一截」，露在屏外的
//   那截里的按钮 / 滚动尾巴够不着，所以面板内再包一层 body，高度跟 detent 走。
//   vaul 自己的松手判定只认「最近 snap 点 + 速度」，不会按位置关；这里在 vaul
//   的 onRelease 之前先算好去向，再在 microtask 里覆盖它写的 transform。
//
// z-50 而不是 modal 的 60：FilePreview（z-60）要能从工作区文件抽屉里打开并盖在上面。

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  widthClassName?: string;
  /** 读屏用的对话框名；不传则为「抽屉」 */
  title?: string;
  /** 手机 sheet：禁止下拉关闭（有草稿时用），拖下去松手会回弹原位。Esc / 关闭按钮不受影响。 */
  preventDismiss?: boolean;
  children: ReactNode;
};

/** full 档离屏顶的留白 */
const SHEET_TOP_GAP = 64;
/** 默认档 = 屏高 56%，不低于 320px */
const SHEET_DEFAULT_RATIO = 0.56;
const SHEET_DEFAULT_MIN = 320;
/** 松手时露出高度低于默认档的这个比例 → 关 */
const SHEET_CLOSE_RATIO = 0.62;
/** 甩动判定：松手前最近 ~100ms 的速度 px/ms + 总位移 px（用平均速度的话，慢拖也会被当成甩） */
const SHEET_FLICK_VELOCITY = 0.6;
const SHEET_FLICK_WINDOW_MS = 100;
const SHEET_FLICK_DISTANCE = 24;
/** 与 --dur-heavy 对齐：detent 收小时，body 等落位动画播完再缩 */
const SHEET_SETTLE_MS = 280;

const noopSubscribe = () => () => {};
const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

export function Drawer(props: DrawerProps) {
  const phone = useMediaQuery(SHEET_DRAWER_QUERY);
  return phone ? <SheetDrawer {...props} /> : <PanelDrawer {...props} />;
}

/** 外壳 + 打开前焦点：两种形态共用 */
function useDrawerShell(open: boolean) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  // SSR 时不渲染外壳（没有 document.body）；客户端 hydrate 后再挂。
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  // 在「刚打开」的那次渲染里记下打开前的焦点（此时面板还没挂载、没抢焦点）。
  const [opener, setOpener] = useState<Element | null>(() =>
    open && typeof document !== "undefined" ? document.activeElement : null,
  );
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && typeof document !== "undefined") setOpener(document.activeElement);
  }
  return { shell, setShell, hydrated, opener };
}

function DrawerShell({
  open,
  onClose,
  setShell,
  scrimRef,
  scrimClassName,
}: {
  open: boolean;
  onClose: () => void;
  setShell: (el: HTMLDivElement | null) => void;
  scrimRef?: Ref<HTMLDivElement>;
  scrimClassName: string;
}) {
  return createPortal(
    <div
      ref={setShell}
      className={cn("fixed inset-0 z-50", !open && "pointer-events-none")}
      aria-hidden={!open}
    >
      <div
        ref={scrimRef}
        onClick={onClose}
        className={cn(
          "absolute inset-0 transition-opacity",
          scrimClassName,
          open ? "opacity-100" : "opacity-0",
        )}
      />
    </div>,
    document.body,
  );
}

function PanelDrawer({
  open,
  onClose,
  widthClassName = "sm:w-[360px]",
  title,
  children,
}: DrawerProps) {
  const { shell, setShell, hydrated, opener } = useDrawerShell(open);
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {hydrated && (
        <DrawerShell
          open={open}
          onClose={onClose}
          setShell={setShell}
          scrimClassName="duration-200 bg-scrim/40 sm:bg-scrim/15"
        />
      )}
      {shell && (
        <DialogPrimitive.Portal container={shell}>
          <LayerContainerContext.Provider value={shell}>
            <DialogPrimitive.Content
              ref={panelRef}
              aria-modal="true"
              data-focus-panel
              aria-describedby={undefined}
              data-safe-area="bottom-sheet"
              onInteractOutside={(e) => e.preventDefault()}
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                focusPanelIfIdle(panelRef.current);
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                restoreFocus(opener);
              }}
              onKeyDown={trapTabKey}
              className={cn(
                "ui-drawer absolute inset-x-0 bottom-0 flex h-[60dvh] flex-col overflow-hidden rounded-t-sheet bg-surface shadow-overlay outline-none",
                "sm:inset-x-auto sm:bottom-2 sm:right-2 sm:top-14 sm:h-auto sm:rounded-overlay sm:border sm:border-line",
                widthClassName,
              )}
              style={{
                paddingBottom: "var(--safe-bottom)",
                paddingLeft: "var(--safe-left)",
                paddingRight: "var(--safe-right)",
              }}
            >
              <DialogPrimitive.Title className="sr-only">{title ?? "抽屉"}</DialogPrimitive.Title>
              {children}
            </DialogPrimitive.Content>
          </LayerContainerContext.Provider>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}

type Detent = 0 | 1; // 0 = 默认档，1 = full
type ReleaseTarget = Detent | "close";

function SheetDrawer({ open, onClose, title, preventDismiss = false, children }: DrawerProps) {
  const { shell, setShell, hydrated, opener } = useDrawerShell(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  const vh = useSyncExternalStore(
    subscribeResize,
    () => window.innerHeight,
    () => 0,
  );
  const fullVisible = Math.max(0, vh - SHEET_TOP_GAP);
  const defaultVisible = Math.min(
    fullVisible,
    Math.max(SHEET_DEFAULT_MIN, Math.round(vh * SHEET_DEFAULT_RATIO)),
  );
  // vaul 的 px snap 点 = 「离屏底多少 px 处是面板顶」，换算成 translateY = vh - snap。
  // 面板本身高 fullVisible、贴底，所以露出高度 v 对应 snap = SHEET_TOP_GAP + v。
  const snapPoints = useMemo(
    () => [`${SHEET_TOP_GAP + defaultVisible}px`, `${vh}px`],
    [defaultVisible, vh],
  );
  const offsetOf = (d: Detent) => (d === 1 ? 0 : fullVisible - defaultVisible);

  const [detent, setDetent] = useState<Detent>(0);
  // body 高度跟 detent：放大立刻放，收小等落位动画播完再缩（不然底部先空一截）
  const [bodyDetent, setBodyDetent] = useState<Detent>(0);
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goDetent = (d: Detent) => {
    setDetent(d);
    if (shrinkTimer.current) clearTimeout(shrinkTimer.current);
    if (d === 1) setBodyDetent(1);
    else shrinkTimer.current = setTimeout(() => setBodyDetent(0), SHEET_SETTLE_MS);
  };
  useEffect(
    () => () => {
      if (shrinkTimer.current) clearTimeout(shrinkTimer.current);
    },
    [],
  );

  // 每次关上都回到默认档，下次从默认档升起。等退场动画播完（面板已卸载）再复位：
  // 退场途中改 activeSnapPoint，vaul 会改写内联 transform，slideToBottom 的起点跟着跳。
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      setDetent(0);
      setBodyDetent(0);
    }, 400);
    return () => clearTimeout(t);
  }, [open]);

  // 开合切换时清掉拖拽写进 scrim 的内联样式，交还给 class 的过渡
  useEffect(() => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    scrim.style.opacity = "";
    scrim.style.transition = "";
  }, [open]);

  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  // 默认档：竖向手势一律拖 sheet（iOS：先展开再滚动）；full 档：内容滚到顶再下拉才拖
  useSheetTouchClaim(panelEl, () => detent === 0);

  const pressRef = useRef<{ y: number; t: number } | null>(null);
  // 最近的 move 采样（算松手速度）
  const samplesRef = useRef<{ y: number; t: number }[]>([]);
  // 非 null = 正在处理一次松手：期间 vaul 发来的 onOpenChange(false) 一律忽略，由 applyRelease 定夺
  const releaseRef = useRef<ReleaseTarget | null>(null);
  const lastReleaseAt = useRef(0);
  const scrimFrame = useRef(0);

  const dragging = () => panelRef.current?.classList.contains("vaul-dragging") ?? false;

  const followScrim = () => {
    if (scrimFrame.current) return;
    scrimFrame.current = requestAnimationFrame(() => {
      scrimFrame.current = 0;
      const panel = panelRef.current;
      const scrim = scrimRef.current;
      if (!panel || !scrim || !dragging()) return;
      const visible = window.innerHeight - panel.getBoundingClientRect().top;
      const ratio = Math.max(0, Math.min(1, visible / defaultVisible));
      scrim.style.transition = "none";
      scrim.style.opacity = String(ratio);
    });
  };

  const applyRelease = (target: ReleaseTarget, top: number) => {
    releaseRef.current = null;
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (target === "close") {
      // 钉在松手位置，退场动画（slideToBottom）从这里接着往下走，不先弹回默认档
      if (panel) {
        panel.style.transition = "none";
        panel.style.transform = `translate3d(0, ${top - (vh - fullVisible)}px, 0)`;
      }
      onClose();
      return;
    }
    goDetent(target);
    if (panel) {
      panel.style.transition = "";
      panel.style.transform = `translate3d(0, ${offsetOf(target)}px, 0)`;
    }
    if (scrim) {
      scrim.style.transition = "";
      scrim.style.opacity = "";
    }
  };

  // vaul 的 Content 先调我们的 onPointerUp / onPointerOut，再跑它自己的 onRelease
  const beforeRelease = (e: ReactPointerEvent<HTMLDivElement> | null) => {
    const panel = panelRef.current;
    const start = pressRef.current;
    if (!e || !panel || !start || !dragging()) return;
    pressRef.current = null;
    lastReleaseAt.current = Date.now();
    const top = panel.getBoundingClientRect().top;
    const visible = window.innerHeight - top;
    const now = Date.now();
    const dy = e.pageY - start.y; // 正 = 向下
    const recent = samplesRef.current.find((p) => now - p.t <= SHEET_FLICK_WINDOW_MS) ?? start;
    const velocity = (e.pageY - recent.y) / Math.max(1, now - recent.t);
    const flick = Math.abs(dy) > SHEET_FLICK_DISTANCE && Math.abs(velocity) > SHEET_FLICK_VELOCITY;
    let target: ReleaseTarget;
    if (visible < defaultVisible * SHEET_CLOSE_RATIO) target = "close";
    // 往下甩：full 先落回默认档，默认档直接关
    else if (flick && velocity > 0) target = detent === 1 ? 0 : "close";
    else if (flick) target = 1;
    else target = Math.abs(visible - fullVisible) < Math.abs(visible - defaultVisible) ? 1 : 0;
    if (target === "close" && preventDismiss) target = 0;
    releaseRef.current = target;
    queueMicrotask(() => applyRelease(target, top));
  };
  // 松手前最后一次 move 的事件：vaul 在 pointerout 时拿它当松手事件
  const lastMove = useRef<ReactPointerEvent<HTMLDivElement> | null>(null);

  return (
    <Vaul.Root
      open={open}
      modal={false}
      noBodyStyles
      repositionInputs={false}
      snapPoints={snapPoints}
      activeSnapPoint={snapPoints[detent]}
      setActiveSnapPoint={(sp) => {
        const d: Detent = sp === snapPoints[1] ? 1 : 0;
        if (d !== detent) goDetent(d);
      }}
      onOpenChange={(next) => {
        if (next || releaseRef.current !== null) return;
        onClose();
      }}
    >
      {hydrated && (
        <DrawerShell
          open={open}
          onClose={onClose}
          setShell={setShell}
          scrimRef={scrimRef}
          scrimClassName="ui-sheet-scrim-fade bg-scrim/40"
        />
      )}
      {shell && (
        <Vaul.Portal container={shell}>
          <LayerContainerContext.Provider value={shell}>
            <Vaul.Content
              ref={(node) => {
                panelRef.current = node;
                setPanelEl(node);
              }}
              aria-modal="true"
              data-focus-panel
              aria-describedby={undefined}
              data-safe-area="bottom-sheet"
              onInteractOutside={(e) => e.preventDefault()}
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                focusPanelIfIdle(panelRef.current);
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                restoreFocus(opener);
              }}
              onKeyDown={trapTabKey}
              onPointerDown={(e) => {
                pressRef.current = { y: e.pageY, t: Date.now() };
                samplesRef.current = [];
              }}
              onPointerMove={(e) => {
                lastMove.current = e;
                const now = Date.now();
                const samples = samplesRef.current.filter((p) => now - p.t <= 200);
                samples.push({ y: e.pageY, t: now });
                samplesRef.current = samples;
                followScrim();
              }}
              onPointerUp={beforeRelease}
              onPointerOut={() => beforeRelease(lastMove.current)}
              className="ui-sheet absolute inset-x-0 bottom-0 flex flex-col rounded-t-sheet bg-surface shadow-overlay outline-none"
              style={{
                height: fullVisible,
                paddingLeft: "var(--safe-left)",
                paddingRight: "var(--safe-right)",
              }}
            >
              <div
                className="flex min-h-0 flex-col overflow-hidden rounded-t-sheet"
                style={{
                  height: bodyDetent === 1 ? fullVisible : defaultVisible,
                  paddingBottom: "var(--safe-bottom)",
                }}
              >
                <SheetGrabber
                  className="h-6"
                  onClick={() => {
                    // 拖完松手也会补一个 click，别把它当成「点把手切档」
                    if (Date.now() - lastReleaseAt.current < 300) return;
                    goDetent(detent === 1 ? 0 : 1);
                  }}
                />
                <Vaul.Title className="sr-only">{title ?? "抽屉"}</Vaul.Title>
                <div className="flex min-h-0 flex-1 flex-col">{children}</div>
              </div>
            </Vaul.Content>
          </LayerContainerContext.Provider>
        </Vaul.Portal>
      )}
    </Vaul.Root>
  );
}
