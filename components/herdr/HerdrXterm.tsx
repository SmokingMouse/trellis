// ui-guard-allow-file(hex): terminal theme syntax colors
"use client";

import { memo, useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface HerdrXtermProps {
  ansiText: string;
  className?: string;
  fontSize?: number;
}

export const HerdrXterm = memo(function HerdrXterm({
  ansiText,
  className,
  fontSize = 12,
}: HerdrXtermProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastTextRef = useRef<string>("");

  useEffect(() => {
    let unmounted = false;
    let terminalInstance: Terminal | null = null;
    let fitInstance: FitAddon | null = null;

    async function initTerminal() {
      if (!containerRef.current || termRef.current) return;

      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (unmounted || !containerRef.current) return;

      terminalInstance = new Terminal({
        cursorBlink: false,
        cursorStyle: "bar",
        disableStdin: true, // 只读展示，输入通过底部的 Composer 发送
        fontSize,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        lineHeight: 1.25,
        theme: {
          background: "#0a0b10",
          foreground: "#e4e6ee",
          cursor: "#e4e6ee",
          selectionBackground: "rgba(120, 130, 200, 0.3)",
          black: "#0a0b10",
          red: "#f85149",
          green: "#3fb950",
          yellow: "#d29922",
          blue: "#58a6ff",
          magenta: "#bc8cff",
          cyan: "#39c5cf",
          white: "#b1bac4",
          brightBlack: "#484f58",
          brightRed: "#ff7b72",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd",
          brightWhite: "#f0f6fc",
        },
        convertEol: true,
        scrollback: 3000,
      });

      fitInstance = new FitAddon();
      terminalInstance.loadAddon(fitInstance);
      terminalInstance.open(containerRef.current);

      termRef.current = terminalInstance;
      fitRef.current = fitInstance;

      try {
        fitInstance.fit();
      } catch {
        /* 容器初始可能尚未完成 layout */
      }

      if (lastTextRef.current) {
        terminalInstance.reset();
        terminalInstance.write(lastTextRef.current);
        terminalInstance.scrollToBottom();
      }
    }

    void initTerminal();

    const resizeObserver = new ResizeObserver(() => {
      if (fitRef.current) {
        try {
          fitRef.current.fit();
        } catch {
          /* layout 抖动防护 */
        }
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      unmounted = true;
      resizeObserver.disconnect();
      if (termRef.current) {
        try {
          termRef.current.dispose();
        } catch {
          /* 销毁安全 */
        }
        termRef.current = null;
        fitRef.current = null;
      }
    };
  }, [fontSize]);

  // 当外部 ansiText 变化时，重新渲染终端内容
  useEffect(() => {
    lastTextRef.current = ansiText;
    const term = termRef.current;
    if (!term || !ansiText) return;

    term.reset();
    term.write(ansiText);
    term.scrollToBottom();
  }, [ansiText]);

  return (
    <div
      ref={containerRef}
      className={`h-full w-full overflow-hidden bg-[#0a0b10] select-text font-mono ${className || ""}`}
    />
  );
});
