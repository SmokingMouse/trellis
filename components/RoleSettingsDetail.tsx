"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, ContactRound, Copy, CopyPlus, MessageCircle, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  RoleAvatar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  useConfirm,
} from "@/components/ui";
import { RoleField, RoleHuePicker, RoleModelSelect } from "@/components/RoleFields";
import { RoleMemoryPanel } from "@/components/RoleMemoryPanel";
import { useHubNodes } from "@/hooks/useHubNodes";
import { copyText } from "@/lib/clipboard";
import { copyRoleName, isRoleNameTaken } from "@/lib/role-manage";
import type { Role, RoleInput } from "@/lib/roles";
import { useRoleStore } from "@/stores/roleStore";

// 角色设置页（原型 s-memory 的外框）：头部资料 + 四个 tab。tab 写进 ?tab=，刷新 / 从顶栏
// 齿轮、「记下了…→改一下」深链进来能直接落到记忆页（docs/roles-p1.md「记下了…」行）。
// 各 tab 自己带「保存」按钮（同 Agent 页的显式保存）；记忆开关是 Switch，即时生效。

const TABS = [
  { id: "profile", label: "资料" },
  { id: "persona", label: "人设" },
  { id: "memory", label: "记忆" },
  { id: "advanced", label: "高级" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const isTab = (v: string | null): v is TabId => TABS.some((t) => t.id === v);

export function RoleSettingsDetail({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { roles, loaded, error, refresh } = useRoleStore();
  const nodes = useHubNodes();

  // 直接打开深链时列表还没拉过；拉过也再拉一次，记忆条数 / 最近活跃可能变了
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const role = roles.find((r) => r.id === id) ?? null;
  const rawTab = searchParams.get("tab");
  const tab: TabId = isTab(rawTab) ? rawTab : "profile";

  const setTab = (next: string) => {
    const q = new URLSearchParams(searchParams.toString());
    if (next === "profile") q.delete("tab");
    else q.set("tab", next);
    const qs = q.toString();
    // replace 而不是 push：切 tab 不该堆进后退历史
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  if (!role) {
    if (!loaded) {
      return (
        <div role="status" aria-label="加载中" className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-1/4" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    if (error) return <ErrorCallout error={error} title="角色加载失败" onRetry={() => void refresh()} />;
    return (
      <EmptyState
        icon={ContactRound}
        title="找不到这个角色"
        description="它可能已经被删除了。"
        action={
          <Button asChild>
            <Link href="/settings/roles">回角色列表</Link>
          </Button>
        }
        className="rounded-card bg-surface-raised shadow-raise"
      />
    );
  }

  // 多机时显示当前这台的名字；单机直连没有 hub，叫「本机」
  const machine = nodes?.find((n) => n.current)?.name ?? "本机";

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/settings/roles"
        className="-ml-1.5 inline-flex h-7 items-center gap-1 self-start rounded-field px-1.5 text-label text-ink-muted transition-colors duration-100 hover:bg-surface-hover hover:text-ink max-md:min-h-11"
      >
        <Icon icon={ArrowLeft} size="sm" />
        全部角色
      </Link>

      <header className="flex flex-wrap items-center gap-4">
        <RoleAvatar role={role} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[20px] font-semibold leading-7 tracking-tight text-ink-strong">
            <span className="truncate">{role.name}</span>
            {role.builtin && <Badge>内置</Badge>}
          </h1>
          <p className="mt-0.5 text-ui text-ink-muted">
            {role.intro && <span>{role.intro} · </span>}
            跑在 {machine} · 默认目录{" "}
            <span className="font-mono text-label">{role.workDir ?? "角色目录"}</span>
          </p>
        </div>
        <Button asChild>
          <Link href={`/?role=${encodeURIComponent(role.id)}`}>
            <Icon icon={MessageCircle} />
            返回对话
          </Link>
        </Button>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="角色设置分区" className="overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* key 绑 updatedAt：保存后服务端回的新值要重新灌进表单草稿 */}
        <TabsContent value="profile" className="pt-5">
          <ProfileTab key={role.updatedAt} role={role} roles={roles} />
        </TabsContent>
        <TabsContent value="persona" className="pt-5">
          <PersonaTab key={role.updatedAt} role={role} />
        </TabsContent>
        <TabsContent value="memory" className="pt-5">
          <RoleMemoryPanel role={role} />
        </TabsContent>
        <TabsContent value="advanced" className="pt-5">
          <AdvancedTab role={role} roles={roles} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 保存一组字段；成功 toast，失败把错误交回给表单显示。 */
function useSaveRole(id: string) {
  const update = useRoleStore((s) => s.update);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<RoleInput>) => {
    setSaving(true);
    setError(null);
    const r = await update(id, patch);
    setSaving(false);
    if (typeof r === "string") setError(r);
    else toast.success("已保存");
  };
  return { saving, error, save };
}

function ProfileTab({ role, roles }: { role: Role; roles: Role[] }) {
  const { saving, error, save } = useSaveRole(role.id);
  const [name, setName] = useState(role.name);
  const [hue, setHue] = useState(role.avatarHue);
  const [glyph, setGlyph] = useState(role.avatarGlyph);
  const [intro, setIntro] = useState(role.intro);
  const [model, setModel] = useState(role.model);
  const [workDir, setWorkDir] = useState(role.workDir ?? "");

  const nameTaken = isRoleNameTaken(name, roles, role.id);
  const dirty =
    name !== role.name ||
    hue !== role.avatarHue ||
    glyph !== role.avatarGlyph ||
    intro !== role.intro ||
    model !== role.model ||
    (workDir.trim() || null) !== role.workDir;

  return (
    <form
      className="flex max-w-[760px] flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || nameTaken || !name.trim()) return;
        void save({
          name: name.trim(),
          avatarHue: hue,
          avatarGlyph: glyph.trim(),
          intro: intro.trim(),
          model,
          workDir: workDir.trim() || null,
        });
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RoleField
          label="名字"
          hint="名字不能和已有角色重复"
          error={nameTaken ? "已经有叫这个名字的角色了" : null}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              invalid={nameTaken}
              required
              maxLength={40}
              autoComplete="off"
            />
          )}
        </RoleField>
        <RoleField label="头像上的字" hint="只取第一个字；留空就用名字的第一个字">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={glyph}
              onChange={(e) => setGlyph(e.target.value)}
              maxLength={4}
              placeholder={Array.from(name.trim())[0] ?? ""}
              autoComplete="off"
            />
          )}
        </RoleField>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-ui font-medium text-ink">头像颜色</span>
        <RoleHuePicker hue={hue} name={name} glyph={glyph} onChange={setHue} />
      </div>

      <RoleField label="一句话介绍" hint="侧栏和顶栏上名字旁边那句">
        {({ id, describedBy }) => (
          <Input id={id} aria-describedby={describedBy} value={intro} onChange={(e) => setIntro(e.target.value)} />
        )}
      </RoleField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
        <RoleField label="默认目录" hint="不填就用角色自己的目录；改了只影响之后新开的话题">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              className="font-mono"
              placeholder={role.homeDir}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </RoleField>
        <RoleField label="模型">
          {({ id }) => <RoleModelSelect id={id} value={model} onChange={setModel} />}
        </RoleField>
      </div>

      {error && <ErrorCallout compact error={error} title="保存没有成功" />}
      <div>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || nameTaken || !name.trim()}>
          保存
        </Button>
      </div>
    </form>
  );
}

function PersonaTab({ role }: { role: Role }) {
  const { saving, error, save } = useSaveRole(role.id);
  const [prompt, setPrompt] = useState(role.systemPrompt);
  const dirty = prompt !== role.systemPrompt;
  return (
    <form
      className="flex max-w-[760px] flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void save({ systemPrompt: prompt });
      }}
    >
      <RoleField
        label="性格与说话方式"
        hint="这是它的人设正文。记忆（USER.md、MEMORY.md）会另外附在后面，不用写进这里"
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={14}
            className="resize-y"
            placeholder="说话直接，不客套。宁可少给几条可复现的问题，也不堆推测性的意见。"
          />
        )}
      </RoleField>
      {error && <ErrorCallout compact error={error} title="保存没有成功" />}
      <div>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
          保存
        </Button>
      </div>
    </form>
  );
}

function AdvancedTab({ role, roles }: { role: Role; roles: Role[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const { create, remove } = useRoleStore();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"copy" | "delete" | null>(null);

  const copyPath = async () => {
    try {
      await copyText(role.homeDir);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("没能复制", { description: "浏览器不让写剪贴板，手动选中路径复制吧。" });
    }
  };

  const duplicate = async () => {
    setBusy("copy");
    // 只复制资料和人设；记忆、固定会话不带（新角色从零认识你）
    const r = await create({
      name: copyRoleName(role.name, roles.map((x) => x.name)),
      intro: role.intro,
      systemPrompt: role.systemPrompt,
      avatarHue: role.avatarHue,
      avatarGlyph: role.avatarGlyph,
      model: role.model,
      workDir: role.workDir,
      memoryEnabled: role.memoryEnabled,
    });
    setBusy(null);
    if (typeof r === "string") {
      toast.error("没能复制", { description: r });
      return;
    }
    toast.success(`已复制成「${r.name}」`);
    router.push(`/settings/roles/${encodeURIComponent(r.id)}`);
  };

  const del = async () => {
    const ok = await confirm({
      title: `删除角色「${role.name}」？`,
      description:
        "它的固定会话会从侧栏消失。角色目录（记忆、USER.md）不会删，只会改名成 .deleted-<时间> 留在原处，需要时可以手动找回。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    const err = await remove(role.id);
    setBusy(null);
    if (err) {
      toast.error("删除没有成功", { description: err });
      return;
    }
    toast.success("角色已删除");
    router.push("/settings/roles");
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-card bg-surface-raised p-4 shadow-raise">
        <h2 className="text-ui font-semibold text-ink-strong">角色目录</h2>
        <p className="text-label text-ink-muted">USER.md、MEMORY.md 和 memories/ 都在这里，可以直接用编辑器改。</p>
        <div className="flex items-center gap-2 rounded-field bg-surface-canvas px-2.5 py-1.5 shadow-hairline">
          <code className="min-w-0 flex-1 truncate font-mono text-label text-ink" title={role.homeDir}>
            {role.homeDir}
          </code>
          <IconButton label={copied ? "已复制" : "复制路径"} size="sm" onClick={() => void copyPath()}>
            <Icon icon={copied ? Check : Copy} size="sm" />
          </IconButton>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-card bg-surface-raised p-4 shadow-raise">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui font-semibold text-ink-strong">复制成新角色</h2>
          <p className="text-label text-ink-muted">带上资料和人设，记忆和会话不带。</p>
        </div>
        <Button onClick={() => void duplicate()} loading={busy === "copy"} disabled={busy !== null}>
          <Icon icon={CopyPlus} />
          复制成新角色
        </Button>
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-card border border-danger-line p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui font-semibold text-ink-strong">删除角色</h2>
          <p className="text-label text-ink-muted">
            {role.builtin ? "内置角色不能删除。" : "目录会保留（改名成 .deleted-<时间>），不会真的删掉记忆文件。"}
          </p>
        </div>
        <Button
          variant="danger"
          onClick={() => void del()}
          loading={busy === "delete"}
          disabled={role.builtin || busy !== null}
        >
          <Icon icon={Trash2} />
          删除
        </Button>
      </section>
    </div>
  );
}
