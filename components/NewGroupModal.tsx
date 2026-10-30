"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { Button, Checkbox, ErrorCallout, Icon, IconButton, Input, Modal, cn } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { RoleField } from "@/components/RoleFields";
import { useRoleStore } from "@/stores/roleStore";
import { BUTLER_AGENT_ID } from "@/lib/butler";
import { useGroupStore } from "@/stores/groupStore";
import { useSessionStore } from "@/stores/sessionStore";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "@/lib/groups";

// 新建群聊弹窗（侧栏「角色」分区 ＋ → 新建群聊）：名字、选 2–6 位角色、工作目录（可选）。
// 开关在 groupStore.newGroupOpen，根布局挂一次 NewGroupHost（同 NewRoleHost）。

export function NewGroupHost() {
  const open = useGroupStore((s) => s.newGroupOpen);
  const setOpen = useGroupStore((s) => s.setNewGroupOpen);
  return open ? <NewGroupModal onClose={() => setOpen(false)} /> : null;
}

export function NewGroupModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { roles, loaded, refresh } = useRoleStore();
  const create = useGroupStore((s) => s.create);
  const provider = useSessionStore((s) => s.provider);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [workDir, setWorkDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const usable = roles.filter((r) => r.enabled && r.id !== BUTLER_AGENT_ID);
  const full = picked.length >= GROUP_MAX_MEMBERS;
  const canCreate = !!name.trim() && picked.length >= GROUP_MIN_MEMBERS && !busy;

  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= GROUP_MAX_MEMBERS ? cur : [...cur, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const r = await create({ name: name.trim(), roleIds: picked, workDir: workDir.trim() || null, provider });
    setBusy(false);
    if (typeof r === "string") {
      setError(r);
      return;
    }
    onClose();
    if (pathname === "/") await useSessionStore.getState().previewSession(r.id);
    else router.push(`/?session=${encodeURIComponent(r.id)}`);
  };

  return (
    <Modal onClose={onClose} size="lg" title="新建群聊">
      <form onSubmit={submit} className="flex max-h-[min(88dvh,760px)] flex-col" data-new-group-modal>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 flex-1 text-body font-semibold tracking-tight text-ink-strong">新建群聊</h2>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
          <RoleField inline label="群名">
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={40}
                placeholder="例如：方案评审"
                autoComplete="off"
              />
            )}
          </RoleField>

          <div className="flex flex-col gap-1 md:grid md:grid-cols-[96px_minmax(0,1fr)] md:items-start md:gap-x-4">
            <span className="text-ui font-medium text-ink md:pt-1.5 md:text-ink-muted">成员</span>
            <div className="flex flex-col gap-1.5">
              {usable.length === 0 ? (
                <div className="rounded-card bg-surface-canvas px-3 py-3 text-label text-ink-muted shadow-hairline">
                  {loaded ? "还没有角色。先建两个角色，再拉它们进群。" : "正在读取角色…"}
                </div>
              ) : (
                <div
                  role="group"
                  aria-label="选 2–6 位角色"
                  className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto rounded-card bg-surface-canvas shadow-hairline"
                >
                  {usable.map((r) => {
                    const on = picked.includes(r.id);
                    const disabled = !on && full;
                    return (
                      <label
                        key={r.id}
                        data-new-group-role={r.id}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors duration-100",
                          on ? "bg-surface-hover" : "hover:bg-surface-hover",
                          disabled && "cursor-not-allowed opacity-55",
                        )}
                      >
                        <Checkbox checked={on} disabled={disabled} onCheckedChange={() => toggle(r.id)} aria-label={r.name} />
                        <RoleAvatar role={r} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ui font-medium text-ink">{r.name}</span>
                          {r.intro && <span className="block truncate text-label text-ink-muted">{r.intro}</span>}
                        </span>
                        {on && (
                          <span className="shrink-0 text-label tabular-nums text-ink-faint">#{picked.indexOf(r.id) + 1}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              <span className="text-label text-ink-muted">
                选 {GROUP_MIN_MEMBERS}–{GROUP_MAX_MEMBERS} 位，已选 {picked.length} 位。没人被 @ 时默认挑最合适的一位回。
              </span>
            </div>
          </div>

          <RoleField inline label="工作目录" hint="不填就让每位在自己的目录里干活">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={workDir}
                onChange={(e) => setWorkDir(e.target.value)}
                className="font-mono"
                placeholder="/Users/you/code/project"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </RoleField>

          {error && <ErrorCallout compact error={error} title="没能建群" />}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          <span className="mr-auto hidden text-label text-ink-muted md:inline">@ 谁就让谁回，@所有人 每位都回</span>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canCreate}>
            建群
          </Button>
        </div>
      </form>
    </Modal>
  );
}
