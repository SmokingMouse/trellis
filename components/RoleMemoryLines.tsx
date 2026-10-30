"use client";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { useRoleStore } from "@/stores/roleStore";
import { Icon, toast } from "@/components/ui";
import { memoryWritesOf, type MemoryWrite } from "@/lib/role-timeline";
import type { Role } from "@/lib/roles";
import type { ChatNode } from "@/lib/types";

// 回复下面的「记下了…」行（原型 .memline）：角色每记一条，当场可见、可撤销——记忆最怕偷偷记错。
//   - 这一轮新建的记忆文件（工具是 Write）→「撤销」= DELETE 该文件（服务端顺带重建 MEMORY.md）；
//   - 改动已有文件（Edit / MultiEdit）→ 只给「改一下」，跳设置页记忆 tab，不在这里回滚内容。
// 会话载荷不带完整 toolCalls（只有 generatedFiles），发现写过记忆就按需拉一次，才分得清新建还是改动。
// 颜色借 fork 那套兰紫 token（原型的 --violet）。

const ACTION =
  "shrink-0 rounded-chip px-1.5 py-0.5 text-label text-ink-faint transition-colors duration-100 hover:bg-surface/60 hover:text-ink max-md:min-h-9";

export function RoleMemoryLines({ role, node }: { role: Role; node: ChatNode }) {
  const writes = memoryWritesOf(node, role.homeDir);
  const needToolCalls = writes.length > 0 && node.toolCalls.length === 0 && node.status === "done";
  const loadNodeToolCalls = useSessionStore((s) => s.loadNodeToolCalls);
  useEffect(() => {
    if (needToolCalls) void loadNodeToolCalls(node.id);
  }, [needToolCalls, loadNodeToolCalls, node.id]);
  const list = useRoleStore((s) => s.memories[role.id]);
  const loadedAt = useRoleStore((s) => s.memoriesLoadedAt[role.id] ?? 0);
  // 列表得是这一轮结束之后拉的，「里面没有」才说明被删了；更早的列表本来就不会有新写的文件。
  const turnEnd = node.status === "streaming" ? Infinity : node.createdAt + (node.durationMs ?? 0);
  const listFresh = Boolean(list) && loadedAt >= turnEnd;

  if (writes.length === 0) return null;
  return (
    <div data-role-memory-lines className="mt-2 flex flex-col gap-1.5">
      {writes.map((w) => (
        <MemoryLine
          key={w.path}
          role={role}
          write={w}
          name={list?.memories.find((m) => m.file === w.file)?.name ?? null}
          // 列表拉到了、里面却没有这个文件：已经被删（别处撤销 / 设置页删掉 / 夜间整理合并）。
          missing={listFresh && !list!.memories.some((m) => m.file === w.file)}
        />
      ))}
    </div>
  );
}

function MemoryLine({
  role,
  write,
  name,
  missing,
}: {
  role: Role;
  write: MemoryWrite;
  name: string | null;
  missing: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "undone">("idle");
  // 撤销后缓存里就没这条了，名字记在撤销那一刻，划掉的行仍显示原名。
  const [undoneName, setUndoneName] = useState<string | null>(null);
  const undone = state === "undone";
  const gone = undone || missing;
  const editHref = `/settings/roles/${encodeURIComponent(role.id)}?tab=memory`;

  const undo = async () => {
    setState("busy");
    setUndoneName(name);
    // roleStore.deleteMemory 顺带更新记忆缓存与 memoryCount：一览「最近记住的」、顶栏「记得 N 条」跟着变。
    const err = await useRoleStore.getState().deleteMemory(role.id, write.file);
    if (err) {
      setState("idle");
      toast.error(`撤销失败：${err}`);
      return;
    }
    setState("undone");
  };

  return (
    <div
      data-role-memory-line={write.file}
      data-undone={gone || undefined}
      className={`flex max-w-[560px] items-center gap-2 rounded-field py-1.5 pr-1.5 pl-2.5 text-[12.5px] text-ink-muted max-md:flex-wrap max-md:text-[13px] ${
        gone ? "bg-surface-muted opacity-70" : "ui-enter-up bg-fork-muted"
      }`}
    >
      <Icon icon={Brain} size="sm" className="shrink-0 text-fork" />
      <span className={`min-w-0 flex-1 truncate max-md:basis-[calc(100%-30px)] max-md:whitespace-normal ${gone ? "line-through" : ""}`}>
        {write.tool === "Write" ? "记下了 " : "更新了 "}
        <b className="font-medium text-ink">{name ?? undoneName ?? write.file.replace(/\.md$/, "")}</b>
      </span>
      {undone ? (
        <span className="shrink-0 px-1.5 text-label text-ink-faint">已撤销</span>
      ) : missing ? (
        <span className="shrink-0 px-1.5 text-label text-ink-faint">已不在记忆里</span>
      ) : (
        <>
          {write.tool === "Write" && (
            <button type="button" className={ACTION} disabled={state === "busy"} onClick={() => void undo()}>
              撤销
            </button>
          )}
          <a href={editHref} className={ACTION}>
            改一下
          </a>
        </>
      )}
    </div>
  );
}

/** 角色会话里保持记忆列表新鲜：进会话拉一次，每答完一轮（多半刚写过记忆）再拉。
 * 记忆行的名字、一览面板、顶栏「记得 N 条」都读这份缓存。 */
export function useRoleMemorySync(roleId: string | null) {
  const settled = useSessionStore((s) =>
    roleId ? Object.values(s.nodes).filter((n) => n.status !== "streaming").length : 0,
  );
  useEffect(() => {
    if (!roleId) return;
    const store = useRoleStore.getState();
    void store.loadMemories(roleId);
    // memoryCount 在角色列表上，一并刷新。
    if (settled > 0) void store.refresh();
  }, [roleId, settled]);
}
