// ui-guard-allow-file(hex): terminal theme syntax colors
"use client";

import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@/components/ui";

// 正则识别器
const DIVIDER_RE = /^[\s─━═—\-╌┄┈_▔▁]{6,}$/;
const PROMPT_RE = /^([❯$➜>]\s?)(.*)$/;
const ACTION_RE = /^(⏺\s?)(.*)$/;
const TOOL_RE = /^(\s*⎿\s?)(.*)$/;
const THINK_RE = /^(?:✽\s?|Thought for\s*)(\d+s)?(?:,\s*(.+))?$/i;
const THOUGHT_FULL_RE = /^Thought for (\d+s)(?:,\s*(.+))?$/i;
const RECAP_RE = /^※\s*(recap:?.*)$/i;
const STATUS_RE = /(⏵⏵|shift\+tab|ctx:\d+%|git:\()/i;
const BULLET_RE = /^(\s*[*\-•]\s+)(.*)$/;
const TUI_BOTTOM_RE = /Jump to bottom\s*\(ctrl\+End\)\s*↓?/i;
const BYPASS_STATUS_RE = />>\s*bypass permissions on\s*\(([^)]+)\)\s*(?:[·•]\s*(.*))?$/i;

// 表格框线符号集合
const TABLE_CHARS = new Set([
  "+", "-", "|", "=", "─", "━", "│", "┃", "┌", "┐", "└", "┘",
  "├", "┤", "┬", "┴", "┼", "═", "║", "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬"
]);

function isTableBorderLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 3) return false;
  // 必须以 +, ┌, ├, └, ╔, ╠, ╚ 等开头，并包含多个连字符
  return /^[+┌├└╔╠╚][─━\-=+┬┴┼═╦╩╬-]+[+┐┤┘╗╣╝]$/.test(t) || /^\+[ -+]+\+$/.test(t);
}

function isTableCellLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 3) return false;
  // 两侧带边框线，且中间含有内容或分隔
  return (t.startsWith("|") || t.startsWith("│") || t.startsWith("║")) &&
         (t.endsWith("|") || t.endsWith("│") || t.endsWith("║"));
}

function isTableRow(line: string): boolean {
  return isTableBorderLine(line) || isTableCellLine(line);
}

// 格式化表格单行字符：将框线与文字分离着色
function renderTableLine(line: string, lineIndex: number): ReactNode {
  const isBorder = isTableBorderLine(line);
  if (isBorder) {
    return (
      <div key={lineIndex} className="select-none text-[#4a5270] tracking-tight">
        {line}
      </div>
    );
  }

  // 单元格内容行：将 | 弱化为线色，单元格文字保持高清晰 text-[#e4e6ee]
  const parts: ReactNode[] = [];
  let currentWord = "";
  let isHeader = /(?:动作|结果|状态|耗时|名称|阶段|action|result|status|name|summary)/i.test(line);

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (TABLE_CHARS.has(char)) {
      if (currentWord) {
        parts.push(
          <span
            key={`w-${i}`}
            className={cn(
              isHeader ? "font-semibold text-white" : "text-[#e4e6ee]",
            )}
          >
            {currentWord}
          </span>
        );
        currentWord = "";
      }
      parts.push(
        <span key={`b-${i}`} className="text-[#4a5270]">
          {char}
        </span>
      );
    } else {
      currentWord += char;
    }
  }

  if (currentWord) {
    parts.push(
      <span
        key="w-end"
        className={cn(isHeader ? "font-semibold text-white" : "text-[#e4e6ee]")}
      >
        {currentWord}
      </span>
    );
  }

  return (
    <div key={lineIndex} className="min-w-max select-text">
      {parts}
    </div>
  );
}

function renderSemanticLine(line: string, index: number): ReactNode {
  const trimmed = line.trim();

  // 1. 空行
  if (!trimmed) {
    return <div key={index} className="h-2" />;
  }

  // 2. 超长分隔线（折叠为 1px 精细分界线，绝不横向撑开或折成多截）
  if (DIVIDER_RE.test(trimmed)) {
    return <div key={index} className="my-1.5 h-px w-full bg-line-strong" />;
  }

  // 3. 摘要提示条 (※ recap: ...)
  if (RECAP_RE.test(trimmed)) {
    return (
      <div
        key={index}
        className="my-1 w-full max-w-full min-w-0 rounded-field border border-accent-line/60 bg-accent-muted/25 px-2.5 py-1 text-label leading-relaxed text-accent-ink whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
      >
        <span className="font-semibold text-accent">※ </span>
        {trimmed.replace(/^※\s*/, "")}
      </div>
    );
  }

  // 4. 用户命令与输入提示符 (❯ / $ / ➜ / >)
  const promptMatch = trimmed.match(PROMPT_RE);
  if (promptMatch) {
    return (
      <div
        key={index}
        className="my-1 flex w-full max-w-full min-w-0 items-start gap-1.5 font-medium"
      >
        <span className="shrink-0 select-none font-bold text-accent">
          {promptMatch[1]}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all [overflow-wrap:anywhere] text-ink-strong font-semibold">
          {promptMatch[2]}
        </span>
      </div>
    );
  }

  // 5. 坐席动作执行行 (⏺ Finding... / ⏺ Editing...)
  const actionMatch = trimmed.match(ACTION_RE);
  if (actionMatch) {
    return (
      <div
        key={index}
        className="my-0.5 flex w-full max-w-full min-w-0 items-start gap-1 text-label font-medium"
      >
        <span className="shrink-0 text-accent font-bold">⏺</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all [overflow-wrap:anywhere] text-[#e4e6ee] font-medium">
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
        className="my-0.5 ml-2 flex w-[calc(100%-0.5rem)] max-w-[calc(100%-0.5rem)] min-w-0 items-start gap-1.5 rounded-field border border-line-faint bg-surface-raised/60 px-2 py-0.5 font-mono text-label text-ink-muted"
      >
        <span className="shrink-0 select-none text-ink-faint">⎿</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all [overflow-wrap:anywhere] font-semibold text-[#e4e6ee]">
          {toolMatch[2]}
        </span>
      </div>
    );
  }

  // 7. 思考过程 (Thought for 19s, ran 4 shell commands / ✽ Thinking...)
  const thoughtMatch = trimmed.match(THOUGHT_FULL_RE);
  if (thoughtMatch) {
    return (
      <div
        key={index}
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-field border border-[#2e2a1d] bg-[#1a1711] px-2.5 py-0.5 font-mono text-[11px] text-[#cfb274]"
      >
        <span className="shrink-0 text-warn">✽</span>
        <span className="font-medium text-[#f3dfa2]">{`Thought for ${thoughtMatch[1]}`}</span>
        {thoughtMatch[2] && <span className="text-[#a4916a]">{`· ${thoughtMatch[2]}`}</span>}
      </div>
    );
  }

  const thinkMatch = trimmed.match(THINK_RE);
  if (thinkMatch) {
    return (
      <div
        key={index}
        className="my-0.5 flex w-full max-w-full min-w-0 items-center gap-1.5 text-label text-warn"
      >
        <span className="shrink-0 animate-spin motion-reduce:animate-none">✽</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all [overflow-wrap:anywhere] font-medium text-warn-ink">
          {thinkMatch[2] || trimmed}
        </span>
      </div>
    );
  }

  // 8. Claude Code 底部状态栏（告别反白刺眼条）
  const bypassMatch = trimmed.match(BYPASS_STATUS_RE);
  if (bypassMatch) {
    return (
      <div
        key={index}
        className="my-1.5 flex w-full max-w-full flex-wrap items-center justify-between gap-1.5 rounded-field border border-accent-line/40 bg-[#141624] px-2.5 py-1 font-mono text-[11px] text-accent-ink"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <span className="text-accent font-bold">⏵⏵</span>
          <span className="text-ink-strong">bypass permissions on</span>
          <span className="text-ink-faint">({bypassMatch[1]})</span>
        </div>
        {bypassMatch[2] && (
          <div className="text-ink-muted text-nano">{bypassMatch[2]}</div>
        )}
      </div>
    );
  }

  // 9. 列表项与重点段落 (* 预发又发现一个 high: #321 ...)
  const bulletMatch = line.match(BULLET_RE);
  if (bulletMatch) {
    return (
      <div
        key={index}
        className="my-0.5 flex w-full max-w-full min-w-0 items-start gap-1 leading-relaxed"
      >
        <span className="shrink-0 select-none font-bold text-accent">
          {bulletMatch[1]}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all [overflow-wrap:anywhere] text-[#e4e6ee]">
          {bulletMatch[2]}
        </span>
      </div>
    );
  }

  // 10. 成功态与失败态颜色增强
  const isPass = /✓|\(pass\)|PASS\b/.test(line);
  const isFail = /✗|\(fail\)|FAIL\b|Error:|ERR!/.test(line);
  const isStatus = STATUS_RE.test(line);

  if (isPass) {
    return (
      <div
        key={index}
        className="my-0.5 w-full max-w-full min-w-0 whitespace-pre-wrap break-all [overflow-wrap:anywhere] font-medium text-positive"
      >
        {line}
      </div>
    );
  }

  if (isFail) {
    return (
      <div
        key={index}
        className="my-0.5 w-full max-w-full min-w-0 whitespace-pre-wrap break-all [overflow-wrap:anywhere] font-medium text-danger"
      >
        {line}
      </div>
    );
  }

  if (isStatus) {
    return (
      <div
        key={index}
        className="my-1 w-full max-w-full min-w-0 rounded-field border border-[#262a3d] bg-[#121420] px-2 py-0.5 font-mono text-nano text-ink-muted whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
      >
        {line}
      </div>
    );
  }

  // 默认正文文本行：提升至绝对清晰亮色 #e4e6ee（对比度 15.2:1，杜绝黑底黑字与变暗）
  return (
    <div
      key={index}
      className="w-full max-w-full min-w-0 whitespace-pre-wrap break-all [overflow-wrap:anywhere] leading-relaxed text-[#e4e6ee]"
    >
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
  // 1. 去除 ANSI 转义序列与控制字符
  const cleanedText = useMemo(() => {
    if (!text) return "";
    return text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\r/g, "");
  }, [text]);

  const blocks = useMemo(() => {
    if (!cleanedText) return [];
    const rawLines = cleanedText.split("\n");
    // 过滤纯 TUI 提示残留行
    const filteredLines = rawLines.filter((l) => !TUI_BOTTOM_RE.test(l.trim()));

    // 块级合并：将连续的表格行打包成 TableBlock
    type Block =
      | { type: "table"; lines: string[] }
      | { type: "line"; line: string; originalIndex: number };

    const result: Block[] = [];
    let currentTable: string[] = [];

    const flushTable = () => {
      if (currentTable.length > 0) {
        result.push({ type: "table", lines: currentTable });
        currentTable = [];
      }
    };

    filteredLines.forEach((line, index) => {
      if (isTableRow(line)) {
        currentTable.push(line);
      } else {
        flushTable();
        result.push({ type: "line", line, originalIndex: index });
      }
    });

    flushTable();
    return result;
  }, [cleanedText]);

  if (raw) {
    return (
      <pre
        className={cn(
          "w-full max-w-full min-w-0 m-0 whitespace-pre-wrap break-all [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-[#e4e6ee] bg-transparent p-0",
          className,
        )}
      >
        {cleanedText}
      </pre>
    );
  }

  return (
    <div
      className={cn(
        "w-full max-w-full min-w-0 min-h-0 flex-1 font-mono text-[11.5px] leading-relaxed select-text [tab-size:2] text-[#e4e6ee]",
        className,
      )}
    >
      {blocks.map((block, bIndex) => {
        if (block.type === "table") {
          return (
            <div
              key={`table-${bIndex}`}
              className="my-2 w-full max-w-full overflow-x-auto rounded border border-[#252a3d] bg-[#0c0e15] p-2 font-mono text-[11px] leading-snug scrollbar-thin shadow-inner"
            >
              {block.lines.map((line, lIndex) => renderTableLine(line, lIndex))}
            </div>
          );
        }
        return renderSemanticLine(block.line, block.originalIndex);
      })}
    </div>
  );
});
