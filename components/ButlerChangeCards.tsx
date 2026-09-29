"use client";
import { useState } from "react";
import { Check, CircleCheck, FileDiff, ShieldAlert, TriangleAlert, Undo2 } from "lucide-react";
import { Button, Icon, Input, StatusDot, cn } from "@/components/ui";
import { useButlerStore } from "@/stores/butlerStore";
import { describeCron } from "@/lib/cron";
import {
  CHANGE_KIND_LABEL,
  confirmPhrase,
  type ButlerChange,
} from "@/lib/butler";

// 管家改动预览卡：挂在提出它的那一轮下面（按 nodeId）。管家唯一的写入出口 ——
// 卡片上点确认，服务端才进程内重放对应路由。设计稿：docs/ui-redesign/mockups/04-butler.html

const EMPTY: ButlerChange[] = [];

export function ButlerChangeCards({ sessionId, nodeId }: { sessionId: string; nodeId: string }) {
  const all = useButlerStore((s) => s.bySession[sessionId] ?? EMPTY);
  const changes = all.filter((c) => c.nodeId === nodeId);
  if (changes.length === 0) return null;
  return (
    <div data-butler-changes className="mt-3 space-y-3">
      {changes.map((c) => (
        <ChangeCard key={c.id} change={c} />
      ))}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  name: "名称", slug: "标识", description: "说明", systemPrompt: "人设", model: "模型",
  tools: "工具白名单", disallowedTools: "禁用工具", skills: "技能", inheritEnv: "继承本机环境",
  permission: "权限", requireApproval: "逐个审批", enabled: "启用", prompt: "提示词",
  workspacePath: "工作目录", contextMode: "上下文", providerId: "模型", agentId: "Agent",
  larkBotId: "飞书机器人", larkChatId: "飞书群", kind: "类型", config: "配置", triggers: "触发器",
};

// 删除时展示的摘要字段（完整快照太长，挑能认出「是哪一个」的）
const DELETE_SUMMARY = ["name", "slug", "description", "prompt", "workspacePath", "triggers", "enabled"];

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (key === "config" && typeof v === "object" && v && "expr" in v) {
    const expr = String((v as { expr: unknown }).expr);
    return `${expr}  ${describeCron(expr)}`;
  }
  if (key === "skills" && Array.isArray(v)) return v.map((s) => (s as { name?: string }).name ?? JSON.stringify(s)).join("、") || "—";
  if (Array.isArray(v)) return v.join("、") || "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type DiffRow = { key: string; before?: string; after?: string };

function diffRows(c: ButlerChange): { rows: DiffRow[]; mode: "create" | "update" | "delete" } {
  const body = c.body ?? {};
  if (c.kind.endsWith(".create") || c.kind === "trigger.add") {
    return { mode: "create", rows: Object.keys(body).map((k) => ({ key: k, after: fmt(k, body[k]) })) };
  }
  if (c.kind.endsWith(".delete") || c.kind === "trigger.remove") {
    const b = c.before ?? {};
    const keys = c.kind === "trigger.remove" ? Object.keys(b) : DELETE_SUMMARY.filter((k) => k in b);
    return { mode: "delete", rows: keys.map((k) => ({ key: k, before: fmt(k, b[k]) })) };
  }
  const b = c.before ?? {};
  return {
    mode: "update",
    rows: Object.keys(body).map((k) => ({ key: k, before: fmt(k, b[k]), after: fmt(k, body[k]) })),
  };
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

function ChangeCard({ change: c }: { change: ButlerChange }) {
  const act = useButlerStore((s) => s.act);
  const busy = useButlerStore((s) => s.busy[c.id]);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const high = c.risk === "high";
  const pending = c.status === "pending";
  const { rows, mode } = diffRows(c);
  const run = async (action: "apply" | "reject" | "revert") => {
    setErr(await act(c, action, high ? typed : undefined));
  };

  return (
    <div
      data-butler-change={c.id}
      data-status={c.status}
      className={cn(
        "overflow-hidden rounded-card border bg-surface",
        high && pending ? "border-danger-line" : "border-line-strong",
        !pending && "opacity-95",
      )}
    >
      <div className="flex items-center gap-2 border-b border-line-faint px-3.5 py-2.5">
        <Icon icon={high ? ShieldAlert : FileDiff} size="sm" className={high ? "text-danger" : "text-ink-faint"} />
        <span className="text-ui font-semibold text-ink">{CHANGE_KIND_LABEL[c.kind]}</span>
        <span className="min-w-0 truncate text-ui text-ink-muted">{c.targetLabel}</span>
        <span
          className={cn(
            "ml-auto inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-label text-ink-muted",
            high ? "border-danger-line" : "border-line",
          )}
        >
          <StatusDot tone={high ? "danger" : "neutral"} />
          {high ? "高危 · 不可撤销" : "可撤销"}
        </span>
      </div>

      <div
        className={cn(
          "grid text-ui",
          mode === "update" ? "grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[6rem_minmax(0,1fr)]",
        )}
      >
        {mode === "update" && (
          <>
            <div />
            <div className="px-3.5 pt-2 pb-1 text-label text-ink-faint">现在</div>
            <div className="px-3.5 pt-2 pb-1 text-label text-ink-faint">改成</div>
          </>
        )}
        {rows.map((r) => (
          <DiffCells key={r.key} row={r} mode={mode} />
        ))}
      </div>

      {high && pending && (
        <div className="flex items-start gap-2 border-t border-line-faint px-3.5 py-2.5 text-label text-ink-muted">
          <Icon icon={TriangleAlert} size="sm" className="mt-px text-danger" />
          删除连带清掉它的运行记录与触发器，撤销不了。只是不想看到它的话，让管家改成停用就行。
        </div>
      )}
      {(err || c.error) && (
        <div className="border-t border-line-faint px-3.5 py-2 text-label text-danger-ink">{err ?? c.error}</div>
      )}

      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border-t border-line-faint px-3.5 py-2.5",
          c.status === "applied" ? "bg-positive-muted" : "bg-surface-canvas",
        )}
      >
        <span className="min-w-0 truncate font-mono text-nano text-ink-faint">
          {c.method} {c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}
        </span>
        <span className="ml-auto" />
        {pending && (
          <>
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run("reject")}>
              不改了
            </Button>
            {high && (
              <label className="flex items-center gap-1.5 text-label text-ink-muted">
                输入{c.kind === "agent.delete" ? " Agent 名" : "任务名"}确认
                <Input
                  size="sm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={confirmPhrase(c)}
                  className="w-36"
                  aria-label="输入名称确认删除"
                />
              </label>
            )}
            <Button
              size="sm"
              variant={high ? "danger-solid" : "primary"}
              disabled={!!busy || (high && typed !== confirmPhrase(c))}
              onClick={() => void run("apply")}
              data-butler-apply
            >
              {!high && <Icon icon={Check} size="sm" />}
              {busy === "apply" ? "应用中…" : high ? "删除" : "确认应用"}
            </Button>
          </>
        )}
        {c.status === "applied" && (
          <>
            <span className="inline-flex items-center gap-1.5 text-label font-medium text-positive-ink">
              <Icon icon={CircleCheck} size="sm" />
              已应用 · {when(c.decidedAt)}
            </span>
            {c.revertible && (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("revert")} data-butler-revert>
                <Icon icon={Undo2} size="sm" />
                {busy === "revert" ? "撤销中…" : "撤销"}
              </Button>
            )}
          </>
        )}
        {c.status === "reverted" && <span className="text-label text-ink-faint">已撤销 · {when(c.revertedAt)}</span>}
        {c.status === "rejected" && <span className="text-label text-ink-faint">没改 · 你拒绝了这条</span>}
        {c.status === "failed" && <span className="text-label text-danger-ink">应用失败，配置没动</span>}
      </div>
    </div>
  );
}

function DiffCells({ row, mode }: { row: DiffRow; mode: "create" | "update" | "delete" }) {
  const cell = "min-w-0 whitespace-pre-wrap break-words border-t border-line-faint px-3.5 py-2";
  const label = <div className="border-t border-line-faint px-3.5 py-2 text-ink-faint">{FIELD_LABEL[row.key] ?? row.key}</div>;
  if (mode === "update") {
    const same = row.before === row.after;
    return (
      <>
        {label}
        <div className={cn(cell, same ? "text-ink-faint" : "text-ink-muted line-through decoration-danger-line")}><span className="line-clamp-4">{row.before}</span></div>
        <div className={cn(cell, same ? "text-ink-faint" : "bg-positive-muted text-ink shadow-[inset_2px_0_0_var(--positive-line)]")}>
          <span className="line-clamp-4">{row.after}</span>
        </div>
      </>
    );
  }
  return (
    <>
      {label}
      <div
        className={cn(
          cell,
          mode === "create"
            ? "bg-positive-muted text-ink shadow-[inset_2px_0_0_var(--positive-line)]"
            : "text-ink-muted line-through decoration-danger-line",
        )}
      >
        <span className="line-clamp-4">{mode === "create" ? row.after : row.before}</span>
      </div>
    </>
  );
}
