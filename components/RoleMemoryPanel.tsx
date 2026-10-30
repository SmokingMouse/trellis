"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  Pill,
  Select,
  Skeleton,
  Switch,
  Textarea,
  cn,
  toast,
  useConfirm,
} from "@/components/ui";
import { RoleField } from "@/components/RoleFields";
import {
  countMemories,
  groupMemories,
  memoryFileFromName,
  randomHex6,
  searchMemories,
  type MemoryFilter,
} from "@/lib/role-manage";
import { formatRelativeTime } from "@/lib/relative-time";
import { MEMORY_TYPES, MEMORY_TYPE_LABEL, type MemoryType, type Role, type RoleMemory } from "@/lib/roles";
import { useRoleStore } from "@/stores/roleStore";

// 角色设置页「记忆」tab（原型 s-memory）：记忆开关、USER.md、按类型分组的记忆列表。
// 记忆文件由角色在对话里自己写（docs/roles-p1.md「记忆注入」），这里是人工校正的入口：
// 改错的、删过时的、手动补一条。写盘与 MEMORY.md 索引重建都在服务端，这里只调 PUT / DELETE。

// 原型的颜色：偏好 violet → fork；项目原型是 teal，本项目没有 teal，用 positive（同为冷绿）
const TYPE_TONE: Record<MemoryType, "accent" | "fork" | "positive" | "neutral"> = {
  user: "accent",
  feedback: "fork",
  project: "positive",
  reference: "neutral",
};

const FILTERS: { id: MemoryFilter; label: string }[] = [
  { id: "all", label: "全部" },
  ...MEMORY_TYPES.map((t) => ({ id: t, label: MEMORY_TYPE_LABEL[t] })),
];

export function RoleMemoryPanel({ role }: { role: Role }) {
  const confirm = useConfirm();
  const list = useRoleStore((s) => s.memories[role.id]);
  const { loadMemories, update, deleteMemory } = useRoleStore();
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [togglePending, setTogglePending] = useState(false);
  // null = 编辑器关；"new" = 手动加一条；RoleMemory = 改这一条
  const [editing, setEditing] = useState<RoleMemory | "new" | null>(null);

  const reload = async () => {
    setLoadFailed(false);
    const r = await loadMemories(role.id);
    if (!r) setLoadFailed(true);
  };

  // 进 tab 就拉一次：对话里刚写的记忆要能马上看到，不信缓存
  useEffect(() => {
    let alive = true;
    void loadMemories(role.id).then((r) => alive && setLoadFailed(!r));
    return () => {
      alive = false;
    };
  }, [role.id, loadMemories]);

  const searched = useMemo(() => searchMemories(list?.memories ?? [], query), [list, query]);
  const counts = useMemo(() => countMemories(searched), [searched]);
  const groups = useMemo(() => groupMemories(searched, filter), [searched, filter]);

  const toggleMemory = async (on: boolean) => {
    setTogglePending(true);
    const r = await update(role.id, { memoryEnabled: on });
    setTogglePending(false);
    if (typeof r === "string") toast.error("没能切换记忆开关", { description: r });
  };

  const remove = async (m: RoleMemory) => {
    const ok = await confirm({
      title: `删除记忆「${m.name}」？`,
      description: `会删掉 memories/${m.file} 并从 MEMORY.md 索引里去掉；${role.name}以后就不记得这件事了。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const err = await deleteMemory(role.id, m.file);
    if (err) toast.error("删除没有成功", { description: err });
    else toast.success("已删除");
  };

  const memoryEnabled = list?.memoryEnabled ?? role.memoryEnabled;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex cursor-pointer items-center gap-2.5">
          <Switch
            checked={memoryEnabled}
            disabled={togglePending}
            onCheckedChange={(v) => void toggleMemory(v)}
          />
          <span className="text-ui font-medium text-ink">使用记忆</span>
        </label>
        <span className="text-label text-ink-faint">关掉后不读也不写；已有的记忆保留</span>
        <span className="flex-1" />
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          leading={<Icon icon={Search} size="sm" />}
          wrapperClassName="w-full sm:w-56"
          placeholder="搜记忆"
          aria-label="搜记忆"
        />
      </div>

      {!list && !loadFailed ? (
        <div role="status" aria-label="加载中" className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !list ? (
        <ErrorCallout error="记忆加载失败" title="记忆加载失败" onRetry={() => void reload()} />
      ) : (
        <>
          <UserMdCard role={role} text={list.userMd} />

          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="按类型筛选" className="flex flex-wrap items-center gap-1">
              {FILTERS.map((f) => {
                const on = f.id === filter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-label transition-[background-color,color,box-shadow] duration-100 max-md:min-h-11",
                      on
                        ? "bg-surface-raised font-medium text-ink shadow-btn"
                        : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                    )}
                  >
                    {f.label}
                    <span className="tabular-nums text-ink-faint">{counts[f.id]}</span>
                  </button>
                );
              })}
            </div>
            <span className="flex-1" />
            <Button size="sm" onClick={() => setEditing("new")}>
              <Icon icon={Plus} size="sm" />
              手动加一条
            </Button>
          </div>

          {groups.length === 0 ? (
            <EmptyState
              compact
              icon={Search}
              title={query.trim() ? "没有匹配的记忆" : "还没有记忆"}
              description={
                query.trim()
                  ? "换个关键字，或清空搜索看全部。"
                  : `和${role.name}聊得越多，它记下的越多；也可以手动加一条。`
              }
              className="rounded-card border border-dashed border-line"
            />
          ) : (
            groups.map((g) => (
              <section key={g.type} aria-label={MEMORY_TYPE_LABEL[g.type]} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Pill tone={TYPE_TONE[g.type]}>{MEMORY_TYPE_LABEL[g.type]}</Pill>
                  <span className="text-label tabular-nums text-ink-faint">{g.items.length}</span>
                </div>
                <ul className="overflow-hidden rounded-card bg-surface-raised shadow-raise divide-y divide-line">
                  {g.items.map((m) => (
                    <li key={m.file} className="group flex items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-ui font-medium text-ink-strong">{m.name || m.file}</div>
                        {m.description && (
                          <div className="mt-0.5 text-label text-ink-muted">{m.description}</div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-nano text-ink-faint">
                          <span>{formatRelativeTime(m.updatedAt)}更新</span>
                          <span className="font-mono">{m.file}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <IconButton label={`编辑「${m.name || m.file}」`} size="sm" onClick={() => setEditing(m)}>
                          <Icon icon={Pencil} size="sm" />
                        </IconButton>
                        <IconButton label={`删除「${m.name || m.file}」`} size="sm" onClick={() => void remove(m)}>
                          <Icon icon={Trash2} size="sm" />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}

      {editing && (
        <MemoryEditorModal
          role={role}
          memory={editing === "new" ? null : editing}
          existingFiles={list?.memories.map((m) => m.file) ?? []}
          defaultType={filter === "all" ? "user" : filter}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** 「它对你的了解」卡：USER.md 全文，点编辑原地变 textarea。 */
function UserMdCard({ role, text }: { role: Role; text: string }) {
  const saveUserMd = useRoleStore((s) => s.saveUserMd);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    const err = await saveUserMd(role.id, draft);
    setSaving(false);
    if (err) setError(err);
    else {
      setDraft(null);
      toast.success("已保存");
    }
  };

  return (
    <section aria-label="它对你的了解" className="overflow-hidden rounded-card bg-surface-raised shadow-raise">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Icon icon={UserRound} size="sm" className="text-ink-muted" />
        <span className="text-ui font-medium text-ink">它对你的了解</span>
        <span className="font-mono text-nano text-ink-faint">USER.md</span>
        <span className="flex-1" />
        {draft === null && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(text)}>
            编辑
          </Button>
        )}
      </div>
      <div className="border-t border-line px-4 py-3">
        {draft === null ? (
          text.trim() ? (
            <p className="whitespace-pre-wrap text-ui text-ink">{text}</p>
          ) : (
            <p className="text-ui text-ink-faint">还是空的。聊天里它会慢慢记，也可以自己写几句。</p>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="resize-y"
              aria-label="USER.md 内容"
              placeholder="中文交流，术语保留英文。报告多用表格和列表。"
              autoFocus
            />
            {error && <ErrorCallout compact error={error} title="保存没有成功" />}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                取消
              </Button>
              <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 改一条 / 手动加一条。新建时文件名由名字推（memoryFileFromName），建好后不再变。 */
function MemoryEditorModal({
  role,
  memory,
  existingFiles,
  defaultType,
  onClose,
}: {
  role: Role;
  memory: RoleMemory | null;
  existingFiles: string[];
  defaultType: MemoryType;
  onClose: () => void;
}) {
  const saveMemory = useRoleStore((s) => s.saveMemory);
  const [name, setName] = useState(memory?.name ?? "");
  const [description, setDescription] = useState(memory?.description ?? "");
  const [type, setType] = useState<MemoryType>(memory?.type ?? defaultType);
  const [body, setBody] = useState(memory?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 新建时的文件名随名字实时推，显示出来让人知道会写到哪。随机回落的 6 位在弹窗打开时定一次，
  // 预览和提交用同一个（不然每敲一个字换一次，显示的也不是最后写的）
  const [rand] = useState(randomHex6);
  const fileFor = (n: string) => memory?.file ?? memoryFileFromName(n, existingFiles, () => rand);
  const previewFile = fileFor(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    const file = fileFor(name);
    const r = await saveMemory(role.id, file, {
      name: name.trim(),
      description: description.trim(),
      type,
      body,
    });
    setSaving(false);
    if (typeof r === "string") {
      setError(r);
      return;
    }
    toast.success(memory ? "已保存" : "已加上");
    onClose();
  };

  return (
    <Modal onClose={onClose} title={memory ? "编辑记忆" : "手动加一条记忆"}>
      <form onSubmit={submit} className="flex max-h-[min(88dvh,720px)] flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 flex-1 text-body font-semibold tracking-tight text-ink-strong">
            {memory ? "编辑记忆" : "手动加一条记忆"}
          </h2>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_9rem]">
            <RoleField label="名字" hint={<span className="font-mono">memories/{previewFile}</span>}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="只报可复现的问题"
                  autoComplete="off"
                />
              )}
            </RoleField>
            <RoleField label="类型">
              {({ id }) => (
                <Select
                  id={id}
                  value={type}
                  onValueChange={(v) => setType(v as MemoryType)}
                  options={MEMORY_TYPES.map((t) => ({ value: t, label: MEMORY_TYPE_LABEL[t] }))}
                />
              )}
            </RoleField>
          </div>
          <RoleField label="一句话描述" hint="进 MEMORY.md 索引，它靠这句判断要不要翻开全文">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="审代码时宁可少报，每条都要有触发条件、位置和影响。"
              />
            )}
          </RoleField>
          <RoleField label="正文">
            {({ id }) => (
              <Textarea
                id={id}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                className="resize-y"
              />
            )}
          </RoleField>
          {error && <ErrorCallout compact error={error} title="保存没有成功" />}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
