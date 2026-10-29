// 手机端「切会话 / 回首页 / 进 Herdr 总览」的转场（View Transitions API）。
//
// app/page.tsx 按 store 状态条件渲染，切换本身是直接替换。要让浏览器先截旧画面、再提交新 DOM，
// 状态更新必须发生在 document.startViewTransition 的回调**里面** —— 而 zustand 的 set 一调，
// React 就会在微任务里提交（useSyncExternalStore 恒为同步车道），早于浏览器下一帧截图；
// 光在 page 上订阅 store 变化再起转场，截到的「旧画面」已经是新的了。
// 所以这里包的是 store 的导航动作本身（loadSession / previewSession / newConversation /
// openHome / openHerdr）：手机断点上把动作挪进转场回调执行，并用 flushSync 让 React 在回调内
// 同步提交。hydrate 走内部 loadSessionInternal，不经过这里 —— 冷启动不播转场。
//
// 异步加载（loadSession 要等网络）期间浏览器停在旧画面；最多等 MAX_HOLD_MS，超时就先放行，
// 数据回来后照常替换（不再有动画）。不支持 / reduced-motion / 桌面：原样直通。
import { flushSync } from "react-dom";
import { useSessionStore } from "@/stores/sessionStore";

export type NavDirection = "forward" | "back";

const MAX_HOLD_MS = 700;

type ViewState = { session: { id: string } | null; homeOpen: boolean; herdrOpen: boolean };

/** 当前顶层视图：某个会话 / 首页 / Herdr 总览 / 无首页的新会话草稿。 */
export function navViewKey(s: ViewState): string {
  if (s.session) return `session:${s.session.id}`;
  if (s.herdrOpen) return "herdr";
  return s.homeOpen ? "home" : "compose";
}

/** 进入会话 = forward；从会话退回首页 / 总览 / 草稿 = back；其余（同一视图、首页↔总览）不播。 */
export function navDirection(from: string, to: string): NavDirection | null {
  if (from === to) return null;
  if (to.startsWith("session:")) return "forward";
  if (from.startsWith("session:")) return "back";
  return null;
}

function canAnimate(): boolean {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function") return false;
  if (document.visibilityState !== "visible") return false;
  if (!window.matchMedia("(max-width: 767.98px)").matches) return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let running = false;
let token = 0;

/** 在转场里执行 update；update 可以是异步的（等它或等到 MAX_HOLD_MS 再截新画面）。 */
function transition<T>(direction: NavDirection, update: () => T): Promise<Awaited<T>> {
  const root = document.documentElement;
  const mine = ++token;
  root.dataset.navVt = direction;
  running = true;
  return new Promise<Awaited<T>>((resolve, reject) => {
    let called = false;
    const vt = document.startViewTransition(async () => {
      called = true;
      let result: Promise<Awaited<T>>;
      try {
        result = Promise.resolve(update()) as Promise<Awaited<T>>;
      } catch (err) {
        result = Promise.reject(err);
      }
      result.then(resolve, reject);
      await Promise.race([
        result.catch(() => undefined),
        new Promise((r) => setTimeout(r, MAX_HOLD_MS)),
      ]);
      // store 更新已排进 React 的同步车道；在截新画面前把它提交掉
      flushSync(() => {});
    });
    vt.updateCallbackDone
      .catch(() => {
        // 回调没被调用（极少见：文档在这一帧被隐藏等）——直接执行，不能把导航吞掉
        if (!called) Promise.resolve(update()).then((v) => resolve(v as Awaited<T>), reject);
      })
      .finally(() => {
        running = false;
      });
    vt.finished
      .catch(() => undefined)
      .finally(() => {
        if (token === mine) delete root.dataset.navVt;
      });
  });
}

function directionTo(target: string): NavDirection | null {
  if (running || !canAnimate()) return null;
  return navDirection(navViewKey(useSessionStore.getState()), target);
}

function wrapAsync<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  target: (...args: A) => string,
): (...args: A) => Promise<R> {
  return (...args) => {
    const dir = directionTo(target(...args));
    if (!dir) return fn(...args);
    return transition(dir, () => fn(...args)) as Promise<R>;
  };
}

function wrapSync<A extends unknown[]>(
  fn: (...args: A) => void,
  target: string,
): (...args: A) => void {
  return (...args) => {
    const dir = directionTo(target);
    if (!dir) {
      fn(...args);
      return;
    }
    void transition(dir, () => flushSync(() => fn(...args)));
  };
}

/** 手机断点挂载时安装（app/page.tsx），返回卸载函数（换回原动作）。 */
export function installNavViewTransitions(): () => void {
  const s = useSessionStore.getState();
  const originals = {
    loadSession: s.loadSession,
    previewSession: s.previewSession,
    newConversation: s.newConversation,
    openHome: s.openHome,
    openHerdr: s.openHerdr,
  };
  useSessionStore.setState({
    loadSession: wrapAsync(originals.loadSession, (id) => `session:${id}`),
    previewSession: wrapAsync(originals.previewSession, (id) => `session:${id}`),
    newConversation: wrapSync(originals.newConversation, "home"),
    openHome: wrapSync(originals.openHome, "home"),
    openHerdr: wrapSync(originals.openHerdr, "herdr"),
  });
  return () => useSessionStore.setState(originals);
}
