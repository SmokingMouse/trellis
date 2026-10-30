"use client";
import { useEffect } from "react";
import { Check, Moon, Undo2, X } from "lucide-react";
import { Button, Icon, IconButton, Pill, Skeleton, cn, toast } from "@/components/ui";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import { useRoleStore } from "@/stores/roleStore";
import { roleSettingsHref } from "@/components/RoleGlancePanel";
import { MEMORY_TYPE_LABEL, type Role } from "@/lib/roles";
import { clockLabel } from "@/lib/role-timeline";
import { ROLE_CHANGE_LABEL, roleChangeTitle, type RoleChange, type RoleChangeKind } from "@/lib/role-changes";
import type { ChatNode } from "@/lib/types";
import { systemNodeMeta } from "@/lib/node-meta";

// 夜间整理卡（原型 09-roles.html s-role 的 .chg）：时间线里 meta.kind === 'role-nightly'
// 的系统节点画成它。逐条 ✓ ✗、全部接受；已接受的 7 天内可撤销（沿用管家改动卡的确认 / 撤销语义）。

const KIND_TONE: Record<RoleChangeKind, "positive" | "accent" | "neutral" | "fork"> = {
  add: "positive",
  merge: "accent",
  delete: "neutral",
  skill: "fork",
};

const EMPTY: RoleChange[] = [];

/** 文件变了：一览的「最近记住的」、顶栏「记得 N 条」跟着刷新。 */
function syncMemories(roleId: string) {
  const rs = useRoleStore.getState();
  void rs.loadMemories(roleId);
  void rs.refresh();
}

function rowSubtitle(c: RoleChange): string {
  const p = c.payload;
  const reason = p.reason ? ` · ${p.reason}` : "";
  switch (p.kind) {
    case "add":
      return `${MEMORY_TYPE_LABEL[p.memory.type] ?? p.memory.type}${reason}`;
    case "merge":
      return `${MEMORY_TYPE_LABEL[p.into.type] ?? p.into.type} · ${p.files.length} 条 → 1 条${reason}`;
    case "delete":
      return p.reason || "不再需要";
    case "skill":
      return [p.description, p.reason].filter(Boolean).join(" · ") || p.name;
  }
}

function resultLabel(c: RoleChange): string | null {
  switch (c.status) {
    case "applied":
      return "已接受";
    case "rejected":
      return "已拒绝";
    case "reverted":
      return "已撤销";
    case "failed":
      return "没能应用";
    default:
      return null;
  }
}

export function RoleNightlyCard({ role, node }: { role: Role; node: ChatNode }) {
  const changes = useRoleExtrasStore((s) => s.changesByNode[node.id] ?? null);
  const loadChanges = useRoleExtrasStore((s) => s.loadChanges);
  const acceptAll = useRoleExtrasStore((s) => s.acceptAll);
  const busyAll = useRoleExtrasStore((s) => s.busy[node.id] === "accept-all");

  useEffect(() => {
    void loadChanges(role.id, node.id);
  }, [loadChanges, role.id, node.id]);

  const meta = systemNodeMeta(node);
  const subtitle = typeof meta?.subtitle === "string" ? meta.subtitle : "";
  const list = changes ?? EMPTY;
  const pending = list.filter((c) => c.status === "pending").length;

  const onAcceptAll = async () => {
    const err = await acceptAll(role.id, node.id);
    syncMemories(role.id);
    if (err) toast.error("有改动没能应用", { description: err });
    else toast.success("都接受了");
  };

  return (
    <div
      data-role-nightly-card={node.id}
      className="ui-enter-up overflow-hidden rounded-card bg-surface-raised shadow-raise"
    >
      <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-field bg-fork-muted text-fork">
          <Icon icon={Moon} size="sm" />
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-ink-strong">{node.question || "夜间整理"}</div>
          <div className="truncate text-label text-ink-faint">
            <span className="tabular-nums">{clockLabel(node.createdAt)}</span>
            {subtitle && <> · {subtitle}</>}
          </div>
        </div>
        <span className="flex-1" />
        {pending > 0 && (
          <Button size="sm" loading={busyAll} onClick={() => void onAcceptAll()} data-role-nightly-accept-all>
            全部接受
          </Button>
        )}
      </div>

      {changes === null ? (
        <div className="border-t border-line px-3.5 py-3">
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : list.length === 0 ? (
        <div className="border-t border-line px-3.5 py-3 text-label text-ink-faint whitespace-pre-line">
          {node.response || "这次没有提案"}
        </div>
      ) : (
        list.map((c) => <ChangeRow key={c.id} role={role} change={c} />)
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-canvas px-3 py-2.5 text-label text-ink-faint">
        <span>没接受的改动不会生效；已接受的 7 天内可撤销</span>
        <span className="flex-1" />
        <a href={roleSettingsHref(role.id, "routines")} className="whitespace-nowrap hover:text-ink">
          整理历史
        </a>
      </div>
    </div>
  );
}

function ChangeRow({ role, change: c }: { role: Role; change: RoleChange }) {
  const act = useRoleExtrasStore((s) => s.act);
  const busy = useRoleExtrasStore((s) => s.busy[c.id]);
  const run = async (action: "accept" | "reject" | "revert") => {
    const err = await act(role.id, c, action);
    if (action !== "reject") syncMemories(role.id);
    if (err) toast.error(action === "revert" ? "没能撤销" : "没能应用", { description: err });
  };
  const pending = c.status === "pending";
  const done = c.status === "applied";
  const off = c.status === "rejected" || c.status === "reverted";
  const result = resultLabel(c);

  return (
    <div
      data-role-change={c.id}
      data-status={c.status}
      className={cn(
        "flex items-center gap-2.5 border-t border-line px-3.5 py-2 transition-[background-color,opacity] duration-200",
        pending && "hover:bg-surface-hover",
        done && "bg-positive-muted",
        off && "opacity-45",
      )}
    >
      <span className="w-11 shrink-0">
        <Pill tone={KIND_TONE[c.kind]}>{ROLE_CHANGE_LABEL[c.kind]}</Pill>
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-ui text-ink", off && "line-through")}>{roleChangeTitle(c.payload)}</div>
        {/* 手机上窄：副标题给两行，桌面一行截断（title 里有全文） */}
        <div className="text-[11.5px] text-ink-faint max-md:line-clamp-2 md:truncate" title={rowSubtitle(c)}>
          {c.status === "failed" && c.error ? c.error : rowSubtitle(c)}
        </div>
      </div>
      {result && (
        <span className={cn("shrink-0 text-label", c.status === "failed" ? "text-danger-ink" : "text-ink-faint")}>
          {result}
        </span>
      )}
      {done && c.revertible && (
        // 手机上收成图标按钮，把宽度让给中间两行字
        <>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("revert")} className="max-md:hidden" data-role-change-revert>
            <Icon icon={Undo2} size="sm" />
            撤销
          </Button>
          <IconButton label="撤销" size="sm" disabled={!!busy} onClick={() => void run("revert")} className="md:hidden">
            <Icon icon={Undo2} size="sm" />
          </IconButton>
        </>
      )}
      {pending && (
        <span className="flex shrink-0 gap-0.5">
          <IconButton label="接受" size="sm" disabled={!!busy} onClick={() => void run("accept")} data-role-change-accept>
            <Icon icon={Check} size="sm" />
          </IconButton>
          <IconButton label="不要" size="sm" disabled={!!busy} onClick={() => void run("reject")} data-role-change-reject>
            <Icon icon={X} size="sm" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
