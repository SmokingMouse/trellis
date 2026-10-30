"use client";
import { useEffect, useMemo, useState } from "react";
import { Search, Sparkles, Trash2 } from "lucide-react";
import { Button, EmptyState, ErrorCallout, Icon, IconButton, Input, Skeleton, cn, toast, useConfirm } from "@/components/ui";
import { RoleField } from "@/components/RoleFields";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import type { Role } from "@/lib/roles";
import type { RoleCapabilities } from "@/lib/role-routines";

// 角色设置「能力」tab（原型 s-memory tabs）：工具白 / 黑名单、挂载本机技能、角色自己的技能。
// 控件照搬设置 → Agent 页的写法（逗号分隔的工具名、可搜的技能 chip），数据走
// /api/roles/[id]/capabilities —— 角色不出现在 /api/agents 里。

type HostSkill = { name: string; dir: string; description: string };

function parseList(raw: string): string[] | null {
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : null;
}

export function RoleCapabilitiesTab({ role }: { role: Role }) {
  const caps = useRoleExtrasStore((s) => s.capabilities[role.id] ?? null);
  const load = useRoleExtrasStore((s) => s.loadCapabilities);
  useEffect(() => {
    void load(role.id);
  }, [load, role.id]);
  if (!caps) {
    return (
      <div role="status" aria-label="加载中" className="flex max-w-[760px] flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  // key：保存后服务端回的新值重新灌进草稿
  return <CapabilitiesForm key={JSON.stringify(caps)} role={role} caps={caps} />;
}

function CapabilitiesForm({ role, caps }: { role: Role; caps: RoleCapabilities }) {
  const save = useRoleExtrasStore((s) => s.saveCapabilities);
  const deleteSkill = useRoleExtrasStore((s) => s.deleteRoleSkill);
  const confirm = useConfirm();
  const [tools, setTools] = useState(caps.tools?.join(", ") ?? "");
  const [denied, setDenied] = useState(caps.disallowedTools?.join(", ") ?? "");
  const [skills, setSkills] = useState<string[]>(caps.hostSkills);
  const [hostSkills, setHostSkills] = useState<HostSkill[] | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d: { skills?: HostSkill[] }) => setHostSkills(d.skills ?? []))
      .catch(() => setHostSkills([]));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = hostSkills ?? [];
    return q ? list.filter((s) => s.dir.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : list;
  }, [hostSkills, query]);

  const dirty =
    JSON.stringify(parseList(tools)) !== JSON.stringify(caps.tools) ||
    JSON.stringify(parseList(denied)) !== JSON.stringify(caps.disallowedTools) ||
    JSON.stringify([...skills].sort()) !== JSON.stringify([...caps.hostSkills].sort());

  const toggle = (dir: string) =>
    setSkills((cur) => (cur.includes(dir) ? cur.filter((x) => x !== dir) : [...cur, dir]));

  const submit = async () => {
    setSaving(true);
    setError(null);
    const err = await save(role.id, { tools: parseList(tools), disallowedTools: parseList(denied), hostSkills: skills });
    setSaving(false);
    if (err) setError(err);
    else toast.success("已保存");
  };

  const removeSkill = async (name: string) => {
    const ok = await confirm({
      title: `删掉技能「${name}」？`,
      description: "会删除角色目录里的 skills/" + name + "/，之后它就用不上这个技能了。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const err = await deleteSkill(role.id, name);
    if (err) toast.error("没删掉", { description: err });
    else toast.success("技能已删除");
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void submit();
        }}
      >
        <p className="text-label text-ink-muted">
          角色总是继承本机环境（CLAUDE.md、本机技能、MCP 都在），这里只做收窄和额外挂载。
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RoleField label="工具白名单" hint="逗号分隔，留空 = 不限制；有技能时会自动补 Skill">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={tools}
                onChange={(e) => setTools(e.target.value)}
                className="font-mono"
                placeholder="Read, Grep, Glob"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </RoleField>
          <RoleField label="工具黑名单" hint="与白名单互不影响，可同时给">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={denied}
                onChange={(e) => setDenied(e.target.value)}
                className="font-mono"
                placeholder="Bash"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </RoleField>
        </div>

        <RoleField
          label={`挂载本机技能（已选 ${skills.length}）`}
          hint="从本机 ~/.claude/skills/ 额外打包给它。改技能正文自动跟随，不用重新保存"
        >
          {({ id }) => (
            <div>
              <Input
                id={id}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leading={<Icon icon={Search} size="sm" />}
                wrapperClassName="mb-2"
                placeholder="搜索技能…"
                aria-label="搜索技能"
              />
              <div className="flex max-h-[220px] flex-wrap gap-1.5 overflow-y-auto rounded-field bg-surface-canvas p-2 shadow-hairline">
                {hostSkills === null ? (
                  <Skeleton className="h-5 w-1/2" />
                ) : filtered.length === 0 ? (
                  <span className="text-label text-ink-faint">{hostSkills.length ? "没有匹配的技能" : "本机还没有可挂载的技能"}</span>
                ) : (
                  filtered.map((s) => {
                    const on = skills.includes(s.dir);
                    return (
                      <button
                        key={s.dir}
                        type="button"
                        aria-pressed={on}
                        title={s.description}
                        onClick={() => toggle(s.dir)}
                        className={cn(
                          "inline-flex h-6 items-center rounded-full px-2 font-mono text-label transition-[background-color,color,box-shadow] duration-100 max-md:min-h-11",
                          on
                            ? "bg-accent-muted text-accent-ink"
                            : "bg-surface-raised text-ink-muted shadow-hairline hover:bg-surface-hover hover:text-ink",
                        )}
                      >
                        {s.dir}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </RoleField>

        {error && <ErrorCallout compact error={error} title="保存没有成功" />}
        <div>
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
            保存
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 text-ui font-semibold text-ink-strong">
          它自己的技能
          <span className="text-label font-normal text-ink-faint tabular-nums">{caps.roleSkills.length}</span>
        </h2>
        <p className="text-label text-ink-muted">
          夜间整理从反复出现的做法里提的（接受后才会出现在这里），放在角色目录的 skills/ 下，只有它能用。
        </p>
        {caps.roleSkills.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="还没有技能"
            description="同一套做法在对话里用过几次后，夜间整理会提议把它存成技能。"
            className="rounded-card bg-surface-raised shadow-raise"
          />
        ) : (
          <div className="overflow-hidden rounded-card bg-surface-raised shadow-raise">
            {caps.roleSkills.map((s) => (
              <div key={s.name} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:border-t [&+&]:border-line">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12.5px] text-ink">{s.name}</div>
                  {s.description && <div className="text-label text-ink-muted">{s.description}</div>}
                  <div className="text-nano text-ink-faint">
                    {new Date(s.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 更新
                  </div>
                </div>
                <IconButton label="删除技能" tone="danger" onClick={() => void removeSkill(s.name)}>
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
