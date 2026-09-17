"use client";
import { useCallback, useRef, useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import type { ToolNode } from "@/lib/tool-tree";
import {
  agentDetailRows,
  buildWorkflowVM,
  columnsForWidth,
  hasValidWorkflowProgress,
  hasWorkflowDetail,
  layoutAgents,
  shortModelName,
  type WorkflowAgentVM,
  type WorkflowPhaseVM,
} from "@/lib/workflow-view";
import { OutputView, Section, StderrView } from "../RawView";
import { AgentStateIcon } from "./WorkflowChrome";

// The Workflow tool's phase tree — 那条工具行展开后的正文。
//
// 表头不在这里：Workflow 就是动线里那条 ToolRow，表头本身就是摘要（见
// WorkflowChrome.WorkflowHead），只有一套结构，不加外框也不加阴影。
//
// 数据全在流里：CLI 把整棵进度树挂在 task_progress 的 `workflow_progress`
// 上，**全量快照**、约 1s 一批（facts #47），所以这里没有任何增量合并逻辑，
// 每一帧都是重新算 —— 排序、计数、分栏阈值都在 lib/workflow-view.ts 里，
// 那些是被单测钉死的产品决定。

export function canRenderWorkflow(node: ToolNode): boolean {
  // A resumed / instantly-failed run can finish before any snapshot arrives.
  // With no phases and no agents there is nothing this view can say that the
  // raw body doesn't say better —— 表头会补一句「暂无阶段明细」，不留空壳。
  //
  // 形状不对的快照走同一条降级路：宁可把原始 JSON 摆出来，也不拿一份自己都
  // 校不过的数据算进度。表头那边的守卫在 ToolRow —— 同一个 helper。
  return hasValidWorkflowProgress(node) && hasWorkflowDetail(node);
}

export function WorkflowView({
  node,
  live = false,
}: {
  node: ToolNode;
  live?: boolean;
}) {
  const vm = buildWorkflowVM(node, live);
  const script = node.meta.prompt ?? null;
  const current = currentStep(vm.phases);
  const running = node.running && live;

  return (
    <>
      {/* 表头下一行安静的等宽小字：跑着时说它在干嘛，跑完说它交回了什么。
          这里露出 task_notification.summary 是有意的 —— 它对 local_workflow
          只是 'Dynamic workflow "…" completed'（facts #46），当摘要读没问题，
          当 report 读才是骗人，所以它永远不进「它交回的结果」那一栏。 */}
      {running && current ? (
        <p className="flex gap-1.5 min-w-0 m-0 pl-5 pb-1 font-mono text-nano leading-4 text-ink-faint">
          <b className="flex-none font-normal">当前</b>
          <span className="min-w-0 truncate">{current}</span>
        </p>
      ) : node.meta.summary ? (
        <p className="flex gap-1.5 min-w-0 m-0 pl-5 pb-1 font-mono text-nano leading-4 text-ink-faint">
          <b className="flex-none font-normal">结果</b>
          <span className="min-w-0 truncate">{node.meta.summary}</span>
        </p>
      ) : null}

      <div className="ml-3 border-l border-line pl-3">
        {vm.phases.map((p) => (
          <PhaseBlock key={p.key} phase={p} />
        ))}
      </div>

      {script && (
        <details>
          <summary className="cursor-pointer select-none text-nano uppercase tracking-wider text-ink-faint hover:text-ink-muted">
            ⚙ 工作流脚本
          </summary>
          <pre className="mt-1 text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-72 overflow-auto">
            {script}
          </pre>
        </details>
      )}

      {node.call.output && (
        <Section label="返回">
          <OutputView text={node.call.output} />
        </Section>
      )}

      {/* 接管 body 就得连错误输出一起接管：一个有合法阶段明细的失败 Workflow
          以前只画 output，stderr 唯一的渲染路径是「明细缺失退回 RawView」——
          等于越是画得出漂亮进度树的失败行，越看不到它为什么挂。 */}
      {node.call.stderr && <StderrView text={node.call.stderr} />}
    </>
  );
}

// "Review: review:security" —— 最近开始、还没跑完的那个 agent。
function currentStep(phases: WorkflowPhaseVM[]): string | null {
  let best: { at: number; text: string } | null = null;
  for (const p of phases) {
    for (const a of p.agents) {
      if (a.state !== "running") continue;
      const at = a.entry.startedAt ?? a.entry.queuedAt ?? a.entry.index;
      if (!best || at >= best.at) {
        best = { at, text: p.title ? `${p.title}: ${a.entry.label}` : a.entry.label };
      }
    }
  }
  return best?.text ?? null;
}

// 一个阶段：含未完成 agent 的默认铺开（那是热区），全完成 / 全排队的收成一
// 行，点击才展开。和 ToolRow 同一套「自动规则 + 用户点击置顶」心智：用户手
// 动开过的阶段不会被下一帧快照收回去。
function PhaseBlock({ phase }: { phase: WorkflowPhaseVM }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? phase.defaultOpen;
  const toggleable = phase.total > 0;
  const [showAll, setShowAll] = useState(false);

  // 「12 行」得是屏幕上真的 12 行。栏数由 CSS auto-fill 决定（桌面 2–4 栏、
  // 手机 1 栏），所以这里量容器宽再反算 —— 写死两栏的话，手机上 24 个 agent
  // 会当成 12 行原样铺开，正好是最需要折叠的那一屏。
  const [columns, setColumns] = useState(2);
  const observer = useRef<ResizeObserver | null>(null);
  // 回调 ref：列表只在展开时进 DOM，unmount 会带着 null 回来，顺手断开。
  const listRef = useCallback((el: HTMLUListElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      setColumns(columnsForWidth(entry.contentRect.width));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  const layout = layoutAgents(phase.agents, columns);

  return (
    <div className="mt-px first:mt-0" data-workflow-phase={phase.title}>
      <button
        type="button"
        onClick={toggleable ? () => setUserOpen(!open) : undefined}
        aria-expanded={toggleable ? open : undefined}
        disabled={!toggleable}
        className={`w-full min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5 pr-1 rounded text-label text-left text-ink-faint pointer-coarse:min-h-[44px] ${
          toggleable ? "cursor-pointer hover:text-ink-muted" : ""
        }`}
      >
        <span
          className="shrink-0 text-ink-faint transition-transform motion-reduce:transition-none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <span className="min-w-0 truncate font-medium text-ink-muted">
          {phase.title}
        </span>
        <span className="shrink-0 font-mono text-nano tabular-nums text-ink-muted">
          {phase.countText}
        </span>
        {phase.metaText && (
          <span className="ml-auto shrink-0 font-mono text-nano tabular-nums text-ink-faint narrow:ml-0">
            {phase.metaText}
          </span>
        )}
      </button>
      {toggleable && open && (
        <ul
          ref={listRef}
          className={`list-none m-0 mb-0.5 p-0 pl-4 ${
            layout.grid ? "grid gap-x-4" : ""
          }`}
          data-workflow-agents={layout.grid ? "grid" : "rows"}
          data-workflow-columns={layout.grid ? columns : 1}
          style={
            layout.grid
              ? {
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
                }
              : undefined
          }
        >
          {layout.visible.map((a) => (
            <AgentRow key={a.key} agent={a} phaseTitle={phase.title} />
          ))}
          {layout.folded.length > 0 && (
            <li className="col-span-full py-px">
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                aria-expanded={showAll}
                data-workflow-more
                className="py-0.5 font-mono text-nano leading-[18px] text-ink-faint hover:text-ink-muted hover:underline rounded pointer-coarse:min-h-[44px]"
              >
                {showAll ? layout.lessLabel : layout.moreLabel}
              </button>
            </li>
          )}
          {showAll &&
            layout.folded.map((a) => (
              <AgentRow key={a.key} agent={a} phaseTitle={phase.title} />
            ))}
        </ul>
      )}
    </div>
  );
}

// 一个 agent 一行，窄屏也是一行（模型短名先让路）。点开是元信息面板 ——
// 降级、重试、排队与最近活动的时刻都在那里，那是排查用的东西，不该占常驻位。
function AgentRow({
  agent,
  phaseTitle,
}: {
  agent: WorkflowAgentVM;
  phaseTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const a = agent.entry;
  const model = a.fallbackModel
    ? shortModelName(a.fallbackModel)
    : shortModelName(a.model);
  return (
    <>
      <li
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-workflow-agent={a.label}
        data-state={agent.state}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setOpen(!open);
        }}
        className={`grid items-center gap-x-2 py-0.5 min-h-[22px] text-label leading-[18px] cursor-pointer rounded ${
          open ? "bg-surface-muted/60" : ""
        }`}
        style={{ gridTemplateColumns: "12px minmax(0, 1fr) auto" }}
      >
        <AgentStateIcon state={agent.state} />
        <span
          className={`flex items-center gap-1.5 min-w-0 ${LABEL_TONE[agent.state]}`}
          title={a.label}
        >
          <span className="min-w-0 truncate">{a.label}</span>
          {(a.attempt ?? 1) > 1 && (
            <span
              className="flex-none px-1 rounded border border-line bg-surface-muted font-mono text-nano leading-[15px] text-ink-faint"
              title={`第 ${a.attempt} 次尝试`}
            >
              ×{a.attempt}
            </span>
          )}
        </span>
        {/* 模型短名 / 耗时 / token 都是要读的数值，浅色下 ink-faint 配 nano
            字号偏淡，提一档到 ink-muted。排队行例外 —— 它还没有数值可读，
            那一行本来就该弱下去。 */}
        <span
          className={`flex flex-wrap items-center justify-end gap-x-2 font-mono text-nano leading-4 tabular-nums ${META_TONE[agent.state]}`}
        >
          {model && (
            // 窄屏第一个让位的就是它 —— 保住「一个 agent 一行」。
            <span
              className="inline-block narrow:hidden max-w-36 truncate px-1.5 rounded border border-line bg-surface-muted text-nano leading-[15px] font-medium"
              data-workflow-model
              title={
                a.fallbackModel ? `降级自 ${a.model ?? "—"}` : (a.model ?? "")
              }
            >
              {model}
            </span>
          )}
          {a.durationMs !== undefined && (
            <b className="font-normal">{formatDuration(a.durationMs)}</b>
          )}
          {a.tokens !== undefined && (
            <b className="font-normal">{formatTokens(a.tokens)}</b>
          )}
        </span>
      </li>
      {open && (
        <li
          className="col-span-full list-none ml-5 mb-1.5 pt-1.5 pb-1 pl-2.5 border-l border-line"
          data-workflow-detail={a.label}
        >
          <dl
            className="grid gap-x-3.5 gap-y-0.5 m-0 font-mono text-nano leading-4 tabular-nums"
            style={{
              gridTemplateColumns:
                "repeat(auto-fill, minmax(min(168px, 100%), 1fr))",
            }}
          >
            {agentDetailRows(agent, phaseTitle).map((r) => (
              <div key={r.label} className="flex gap-1.5 min-w-0">
                <dt className="flex-none text-ink-faint">{r.label}</dt>
                <dd className="m-0 min-w-0 truncate text-ink-muted" title={r.title}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
          {/* 参考稿 v1 不给 prompt / 结果；trellis 给 —— 已经采到的东西藏起来
              只会让人多点四层去别处找。默认折叠，不占常驻位。 */}
          {a.promptPreview && (
            <Preview label="交给它的任务" text={a.promptPreview} />
          )}
          {a.resultPreview && (
            <Preview label="它交回的结果" text={a.resultPreview} />
          )}
        </li>
      )}
    </>
  );
}

const LABEL_TONE: Record<WorkflowAgentVM["state"], string> = {
  done: "text-ink-muted",
  running: "text-ink",
  queued: "text-ink-faint",
  failed: "text-danger-ink",
  killed: "text-ink-faint",
};

// 右侧数值区的墨色。只有排队行弱化 —— 它那一栏是空的（没耗时、没 token），
// 弱下去正好；已终止的行标签虽然也弱，但它手里是真跑出来的数字，该读得清。
const META_TONE: Record<WorkflowAgentVM["state"], string> = {
  done: "text-ink-muted",
  running: "text-ink-muted",
  queued: "text-ink-faint",
  failed: "text-ink-muted",
  killed: "text-ink-muted",
};

function Preview({ label, text }: { label: string; text: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer select-none text-nano uppercase tracking-wider text-ink-faint hover:text-ink-muted">
        {label}
      </summary>
      <pre className="mt-1 text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1 max-h-40 overflow-auto">
        {text}
      </pre>
    </details>
  );
}
