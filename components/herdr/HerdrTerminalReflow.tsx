"use client";

import { memo, useMemo } from "react";
import { cn } from "@/components/ui";

const DIVIDER_RE = /^[\s─━═—\-╌┄┈_▔▁]{6,}$/;
const PROMPT_RE = /^([❯$➜>]\s?)(.*)$/;
const ACTION_RE = /^(⏺\s?)(.*)$/;
const TOOL_RE = /^(\s*⎿\s?)(.*)$/;
const THINK_RE = /^(✽\s?)(.*)$/;
const RECAP_RE = /^※\s*(recap:?.*)$/i;
const STATUS_RE = /(⏵⏵|shift\+tab|ctx:\d+%|git:\()/i;

function renderSemanticLine(line: string, index: number) {
  const trimmed = line.trim();

  // 1. 空行
  if (!trimmed) {
    return <div key={index} className="h-2.5" />;
  }

  // 2. 超长分隔线（折叠为 1px 精细分界线）
  if (DIVIDER_RE.test(trimmed)) {
    return <div key={index} className="my-2 h-px w-full bg-line-strong" />;
  }

  // 3. 摘要提示条 (※ recap: ...)
  if (RECAP_RE.test(trimmed)) {
    return (
      <div
        key={index}
        className="my-1.5 rounded-field border border-accent-line bg-accent-muted/20 px-2.5 py-1.5 text-label leading-relaxed text-accent-ink"
      >
        <span className="font-semibold">※ </span>
        {trimmed.replace(/^※\s*/, "")}
      </div>
    );
  }

  // 4. 用户命令与输入提示符 (❯ / $ / ➜ / >)
  const promptMatch = trimmed.match(PROMPT_RE);
  if (promptMatch) {
    return (
      <div key={index} className="my-1 flex items-start gap-1.5 font-medium">
        <span className="shrink-0 select-none font-bold text-accent">
          {promptMatch[1]}
        </span>
        <span className="min-w-0 flex-1 break-words text-ink-strong">
          {promptMatch[2]}
        </span>
      </div>
    );
  }

  // 5. 坐席动作执行行 (⏺ Finding... / ⏺ Editing...)
  const actionMatch = trimmed.match(ACTION_RE);
  if (actionMatch) {
    return (
      <div key={index} className="my-0.5 flex items-start gap-1.5 text-ui font-medium">
        <span className="shrink-0 text-accent font-bold">⏺</span>
        <span className="min-w-0 flex-1 break-words text-ink-strong">
          {actionMatch[2]}
        </span>
      </div>
    );
  }

  // 6. 工具调用子命令行 (⎿ $ ...)
  const toolMatch = line.match(TOOL_RE);
  if (toolMatch) {
    return (
      <div
        key={index}
        className="my-0.5 ml-3 flex items-start gap-1 rounded bg-surface-muted/60 px-2 py-0.5 font-mono text-label text-ink-muted"
      >
        <span className="shrink-0 select-none text-ink-faint">⎿</span>
        <span className="min-w-0 flex-1 break-words font-semibold text-ink">
          {toolMatch[2]}
        </span>
      </div>
    );
  }

  // 7. 思考中状态 (✽ Canoodling... / ✽ Thinking...)
  const thinkMatch = trimmed.match(THINK_RE);
  if (thinkMatch) {
    return (
      <div key={index} className="my-1 flex items-center gap-1.5 text-label text-warn">
        <span className="shrink-0 animate-spin motion-reduce:animate-none">✽</span>
        <span className="break-words font-medium">{thinkMatch[2]}</span>
      </div>
    );
  }

  // 8. 成功态与失败态颜色增强
  const isPass = /✓|\(pass\)|PASS\b/.test(line);
  const isFail = /✗|\(fail\)|FAIL\b|Error:|ERR!/.test(line);
  const isStatus = STATUS_RE.test(line);

  if (isPass) {
    return (
      <div key={index} className="my-0.5 break-words font-medium text-positive">
        {line}
      </div>
    );
  }

  if (isFail) {
    return (
      <div key={index} className="my-0.5 break-words font-medium text-danger">
        {line}
      </div>
    );
  }

  if (isStatus) {
    return (
      <div
        key={index}
        className="my-1 rounded-field border border-line-faint bg-surface-raised px-2 py-1 text-nano text-ink-faint"
      >
        {line}
      </div>
    );
  }

  // 默认文本行：支持自动折行与等宽排版
  return (
    <div key={index} className="min-w-0 break-words leading-relaxed text-ink-muted">
      {line}
    </div>
  );
}

export const HerdrTerminalReflow = memo(function HerdrTerminalReflow({
  text,
  raw = false,
  className,
}: {
  text: string;
  raw?: boolean;
  className?: string;
}) {
  const lines = useMemo(() => {
    if (!text) return [];
    return text.replace(/\r/g, "").split("\n");
  }, [text]);

  if (raw) {
    return (
      <pre
        className={cn(
          "code-surface m-0 min-h-0 whitespace-pre font-mono text-nano leading-relaxed",
          className,
        )}
      >
        {text}
      </pre>
    );
  }

  return (
    <div
      className={cn(
        "min-h-0 flex-1 font-mono text-nano leading-relaxed select-text",
        className,
      )}
    >
      {lines.map((line, index) => renderSemanticLine(line, index))}
    </div>
  );
});
