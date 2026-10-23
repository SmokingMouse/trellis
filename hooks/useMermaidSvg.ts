"use client";
import { useEffect, useState } from "react";
import { peekMermaid, renderMermaid, type MermaidResult } from "@/lib/mermaid";
import { useIsDark } from "./useIsDark";

// 流式输出时源码每帧都在变：静止 STREAM_SETTLE_MS 后才真正渲染，期间保留上一版
// 结果并标 pending——不在半截源码上反复解析、闪错误卡。非流式（写完的回答、
// 文件预览）立即渲染；命中缓存（同源码同主题）首帧就有图。主题切换自动重渲。
const STREAM_SETTLE_MS = 350;

export type MermaidState = {
  /** 最近一次完成的渲染结果（源码变了、新结果还没出时仍是上一版） */
  result: MermaidResult | null;
  /** 当前源码的结果还没出来 */
  pending: boolean;
};

// fallback：流式中途解析失败时借用了上一版的图——流式一结束必须换回真实结果
type Tracked = MermaidState & { key: string; fallback: boolean };

function settle(key: string, code: string | null, dark: boolean, prev: MermaidResult | null): Tracked {
  if (!code) return { key, result: null, pending: false, fallback: false };
  const hit = peekMermaid(code, dark);
  return hit
    ? { key, result: hit, pending: false, fallback: false }
    : { key, result: prev, pending: true, fallback: false };
}

export function useMermaidSvg(
  code: string | null,
  { streaming = false }: { streaming?: boolean } = {},
): MermaidState {
  const dark = useIsDark();
  const key = code ? `${dark ? "d" : "l"}:${code}` : "";
  const [state, setState] = useState<Tracked>(() => settle(key, code, dark, null));

  // 源码 / 主题变了（或流式结束、手里还是借来的旧图）：渲染期就地换算——
  // 命中缓存直接换成真实结果，否则保留旧图标 pending
  let current = state;
  if (state.key !== key || (!streaming && state.fallback)) {
    current = settle(key, code, dark, state.result);
    setState(current);
  }

  const needsRender = current.pending;
  useEffect(() => {
    if (!code || !needsRender) return;
    let alive = true;
    const timer = window.setTimeout(
      () => {
        void renderMermaid(code, dark).then((result) => {
          if (!alive) return;
          setState((prev) => {
            if (prev.key !== key) return prev;
            // 流式中途停在半行上解析失败很正常：继续显示上一版能画的图，定稿再说
            const keepPrevious = streaming && !result.ok && Boolean(prev.result?.ok);
            return {
              key,
              result: keepPrevious ? prev.result : result,
              pending: false,
              fallback: keepPrevious,
            };
          });
        });
      },
      streaming ? STREAM_SETTLE_MS : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key, code, dark, streaming, needsRender]);

  return { result: current.result, pending: current.pending };
}
