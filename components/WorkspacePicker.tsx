"use client";
import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GitBranchPlus,
  Sparkles,
  X,
} from "lucide-react";
import {
  Button,
  Badge,
  Checkbox,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  Select,
  SkeletonText,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";

export type WorkspaceEntry = {
  path: string;
  shortName: string;
  lastUsedAt: number;
  source: "trellis" | "claude" | "both";
};

type Props = {
  // null = "no workspace yet" entry state; non-null = "currently picked, may
  // re-pick" entry state. Used to seed list highlighting only.
  currentPath: string | null;
  onPick: (path: string | null) => void;
  onClose: () => void;
};

type Tab = "recent" | "browse";

/** GET /api/workspaces/worktree 的一项：一个能开 worktree 的 repo。 */
type WorktreeBase = {
  projectId: string;
  projectName: string;
  path: string;
  parent: string;
  branch: string | null;
};

export function WorkspacePicker({ currentPath, onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("recent");
  const [customPath, setCustomPath] = useState("");
  const [scratchBusy, setScratchBusy] = useState(false);
  const [scratchError, setScratchError] = useState<unknown>(null);
  // 「新建 worktree 并使用」：bases=null 表示还没拉到 / 没有可用 repo，
  // 那时整个入口不渲染 —— 一个点了必然报「没有 git 工作区」的按钮不如不给。
  const [bases, setBases] = useState<WorktreeBase[] | null>(null);
  const [wtOpen, setWtOpen] = useState(false);
  const [wtProjectId, setWtProjectId] = useState<string | null>(null);
  const [wtBranch, setWtBranch] = useState("");
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState<unknown>(null);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);

  // Esc-to-close（input 聚焦时不拦截）由 Modal 的 closeOnEsc="outside-inputs"
  // 默认行为提供，与旧手写监听语义一致。

  const pickPath = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    onPick(trimmed);
    onClose();
  };

  // "Blank sandbox": server mkdirs a fresh random empty dir under
  // ~/.trellis/scratch/ and we pick it like any other workspace path —
  // downstream (session creation, spawn cwd, previews) needs no special
  // casing.
  const createScratch = async () => {
    if (scratchBusy) return;
    setScratchBusy(true);
    setScratchError(null);
    try {
      const res = await fetch("/api/workspaces/scratch", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.path) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      pickPath(body.path);
    } catch (err) {
      setScratchError(err);
      setScratchBusy(false);
    }
  };

  // 哪些 repo 能开 worktree。默认选中「当前工作区所在的那个 repo」——
  // 判据是同父目录，因为 worktree 就落在主 checkout 的兄弟位；这样从一个
  // worktree 里再开一个平行 worktree 时下拉也是对的，不用手选。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/workspaces/worktree");
        if (!res.ok) return;
        const { bases } = (await res.json()) as { bases: WorktreeBase[] };
        if (cancelled || !bases?.length) return;
        setBases(bases);
        const near = currentPath
          ? bases.find((b) => dirname(currentPath) === b.parent)
          : undefined;
        setWtProjectId((near ?? bases[0]).projectId);
      } catch {
        // 拉不到就当没有这个入口 —— 其余选目录的路子一条没少。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const wtBase = bases?.find((b) => b.projectId === wtProjectId) ?? null;
  const wtTarget =
    wtBase && wtBranch.trim() ? `${wtBase.parent}/${wtBranch.trim()}` : null;

  const createWorktree = async () => {
    const branch = wtBranch.trim();
    if (!wtBase || !branch || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/workspaces/worktree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: wtBase.projectId, branch }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.path) throw new Error(body.error ?? `HTTP ${res.status}`);
      // 侧栏是靠 sessionsRevision 拉的，不 bump 的话用户选中了一个侧栏上还看
      // 不见的目录 —— 要等到发出第一条消息建了 session 才补上。
      bumpSessionsRevision();
      pickPath(body.path);
    } catch (err) {
      setWtError(err);
      setWtBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="选择工作区" panelClassName="flex flex-col max-h-[85vh]">
      <div className="border-b border-line-faint px-4 py-3 flex items-center gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-ui font-semibold text-ink-strong">选择工作区</h2>
          <div className="text-label text-ink-muted">
            AI 会在这个目录里读写文件、执行命令
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <Icon icon={X} />
        </IconButton>
      </div>

      <div className="border-b border-line-faint px-4 py-2 shrink-0">
        <button
          onClick={createScratch}
          disabled={scratchBusy}
          aria-busy={scratchBusy}
          className="w-full text-left px-3 py-2 rounded-field border border-line hover:bg-surface-hover transition-colors flex items-center gap-3 disabled:opacity-60 disabled:cursor-wait"
        >
          <Icon icon={Sparkles} className="text-ink-faint" />
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-ink">空白沙箱</span>
            <span className="block text-label text-ink-muted">
              不挑目录，新建一个空目录当工作区（~/.trellis/scratch/ 下）
            </span>
          </span>
          {scratchBusy && <Spinner size="sm" label="正在创建" />}
        </button>
        {!!scratchError && (
          <ErrorCallout compact className="mt-1.5" error={scratchError} title="创建空白沙箱失败" />
        )}

        {/* 与「空白沙箱」「新建文件夹」并列的第三个「创建并使用」。
            worktree 以前只能从侧栏的项目行建，建完还不选中，用户得把同一个
            路径用眼睛搬到这个 picker 里再找一遍 —— 而它恰恰不在「最近」里。 */}
        {bases && wtBase && (
          <div className="mt-2">
            <button
              onClick={() => {
                setWtError(null);
                setWtOpen((v) => !v);
              }}
              aria-expanded={wtOpen}
              className="w-full text-left px-3 py-2 rounded-field border border-line hover:bg-surface-hover transition-colors flex items-center gap-3"
            >
              <Icon icon={GitBranchPlus} className="text-ink-faint" />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium text-ink">
                  新建 worktree 并使用
                </span>
                <span className="block text-label text-ink-muted">
                  给新分支开一个平行的工作目录，放在主仓库目录旁边
                </span>
              </span>
              <Icon icon={wtOpen ? ChevronDown : ChevronRight} size="sm" className="text-ink-faint" />
            </button>

            {wtOpen && (
              <div className="mt-1.5 px-3 py-2 rounded-field bg-surface-muted flex flex-col gap-2">
                {/* 只有一个 repo 时不给下拉 —— 一个选项的 select 是纯噪音。 */}
                {bases.length > 1 ? (
                  <div className="flex items-center gap-2 text-label text-ink-muted">
                    <span className="shrink-0">从</span>
                    <Select
                      size="sm"
                      aria-label="从哪个仓库开 worktree"
                      className="flex-1 min-w-0"
                      value={wtBase.projectId}
                      onValueChange={setWtProjectId}
                      options={bases.map((b) => ({
                        value: b.projectId,
                        label: `${b.projectName}${b.branch ? `（${b.branch}）` : ""}`,
                      }))}
                    />
                    <span className="shrink-0">起</span>
                  </div>
                ) : (
                  <div className="text-label text-ink-muted truncate">
                    从 <span className="font-medium text-ink">{wtBase.projectName}</span>
                    {wtBase.branch ? ` (${wtBase.branch})` : ""} 起
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    aria-label="分支名"
                    value={wtBranch}
                    autoFocus
                    disabled={wtBusy}
                    onChange={(e) => setWtBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void createWorktree();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setWtOpen(false);
                      }
                    }}
                    placeholder="分支名"
                    className="flex-1 font-mono"
                  />
                  <Button
                    variant="primary"
                    className="shrink-0"
                    onClick={() => void createWorktree()}
                    loading={wtBusy}
                    disabled={!wtBranch.trim() || wtBusy}
                  >
                    创建并使用
                  </Button>
                </div>

                {/* 落点实时回显：分支名会**原样变成磁盘目录名**，建之前看得见
                    比建完再解释「它去哪了」有用得多。 */}
                <div className="text-label text-ink-faint font-mono truncate">
                  {wtTarget
                    ? `将建在 ${prettifyHome(wtTarget)}`
                    : `将建在 ${prettifyHome(wtBase.parent)}/…`}
                </div>
                {wtError ? (
                  <ErrorCallout compact error={wtError} title="新建 worktree 失败" />
                ) : (
                  <div className="text-label text-ink-muted">
                    已有同名分支就直接检出，否则从当前提交新建分支
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex-1 min-h-0 flex flex-col"
      >
        <TabsList className="px-4 shrink-0">
          <TabsTrigger value="recent">最近</TabsTrigger>
          <TabsTrigger value="browse">浏览</TabsTrigger>
        </TabsList>
        <TabsContent value="recent" className="flex-1 min-h-0 flex flex-col">
          <RecentTab currentPath={currentPath} onPick={pickPath} />
        </TabsContent>
        <TabsContent value="browse" className="flex-1 min-h-0 flex flex-col">
          <BrowseTab currentPath={currentPath} onPick={pickPath} />
        </TabsContent>
      </Tabs>

      <div className="border-t border-line-faint px-4 py-3 shrink-0">
        <div className="text-label text-ink-muted mb-2">
          或手动输入绝对路径
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            aria-label="工作区绝对路径"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                pickPath(customPath);
              }
            }}
            placeholder="/Users/.../some-repo"
            className="flex-1 font-mono"
          />
          <Button
            variant="primary"
            onClick={() => pickPath(customPath)}
            disabled={!customPath.trim()}
          >
            使用
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Recent tab ──────────────────────────────────────────────────────────

function RecentTab({
  currentPath,
  onPick,
}: {
  currentPath: string | null;
  onPick: (p: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/workspaces/recent");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { workspaces } = (await res.json()) as {
          workspaces: WorkspaceEntry[];
        };
        if (!cancelled) {
          setEntries(workspaces);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = filter
    ? entries.filter(
        (e) =>
          e.path.toLowerCase().includes(filter.toLowerCase()) ||
          e.shortName.toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;

  return (
    <>
      <div className="px-4 py-3 border-b border-line-faint shrink-0">
        <Input
          type="text"
          aria-label="筛选最近用过的工作区"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选最近用过的工作区"
          autoFocus
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && <SkeletonText lines={4} className="px-4 py-4" />}
        {!!error && (
          <div className="px-4 py-3">
            <ErrorCallout compact error={error} title="读取最近用过的工作区失败" />
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            compact
            icon={Folder}
            title={filter ? "没有匹配的工作区" : "还没有用过的工作区"}
            description={filter ? undefined : "到「浏览」里挑一个目录，或用上面的空白沙箱。"}
          />
        )}
        {!loading && !error && (
          <ul>
            {filtered.map((e) => {
              const active = e.path === currentPath;
              return (
                <li key={e.path}>
                  <button
                    onClick={() => onPick(e.path)}
                    className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors border-b border-line-faint last:border-b-0 ${
                      active
                        ? "bg-surface-muted"
                        : "hover:bg-surface-hover"
                    }`}
                  >
                    <Icon icon={Folder} className="text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-ui font-medium text-ink truncate">
                        {e.shortName}
                      </span>
                      <span className="block text-label text-ink-muted truncate font-mono">
                        {prettifyHome(e.path)}
                      </span>
                    </span>
                    {active && <Badge variant="accent">当前</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

// ─── Browse tab ──────────────────────────────────────────────────────────

type BrowseEntry = { name: string; path: string };
type BrowseResponse = {
  path: string;
  parent: string | null;
  children: BrowseEntry[];
  truncated: boolean;
  home: string;
};

function BrowseTab({
  currentPath,
  onPick,
}: {
  currentPath: string | null;
  onPick: (p: string) => void;
}) {
  // Where we are right now (server-canonical absolute path).
  const [dir, setDir] = useState<string | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  // Inline "new folder" form: creates a dir under the dir we're viewing and
  // picks it straight away — the only reason to make one from here is to use
  // it as the workspace.
  const [newName, setNewName] = useState<string | null>(null);
  const [mkdirBusy, setMkdirBusy] = useState(false);
  const [mkdirError, setMkdirError] = useState<unknown>(null);

  // Initial location: if there's already a workspace selected, jump to it
  // so the user can see siblings + drill nearby. Otherwise let the server
  // default to $HOME.
  useEffect(() => {
    setDir(currentPath ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch whenever dir or showHidden changes. dir=null means "use server
  // default" (home).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFilter("");
    setNewName(null);
    setMkdirError(null);
    const qs = new URLSearchParams();
    if (dir) qs.set("path", dir);
    if (showHidden) qs.set("showHidden", "true");
    (async () => {
      try {
        const res = await fetch(`/api/workspaces/browse?${qs.toString()}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as BrowseResponse;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, showHidden]);

  // Breadcrumb segments — derived from data.path so server-side path
  // canonicalization (resolve, symlink, trailing slashes) is reflected.
  // Below $HOME we render `~` for the home segment; above, render absolute.
  const segments = useMemo(() => {
    if (!data) return [];
    return buildBreadcrumb(data.path, data.home);
  }, [data]);

  const createDir = async () => {
    const name = (newName ?? "").trim();
    if (!data || !name || mkdirBusy) return;
    setMkdirBusy(true);
    setMkdirError(null);
    try {
      const res = await fetch("/api/workspaces/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: data.path, name }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.path) throw new Error(body.error ?? `HTTP ${res.status}`);
      onPick(body.path);
    } catch (err) {
      setMkdirError(err);
      setMkdirBusy(false);
    }
  };

  const filteredChildren = useMemo(() => {
    if (!data) return [];
    if (!filter) return data.children;
    const needle = filter.toLowerCase();
    return data.children.filter((c) => c.name.toLowerCase().includes(needle));
  }, [data, filter]);

  return (
    <>
      <nav
        aria-label="当前路径"
        className="px-4 py-2 border-b border-line-faint shrink-0 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap text-ui"
      >
        {segments.map((seg, i) => (
          <span key={seg.path} className="flex items-center gap-2 shrink-0">
            {i > 0 && (
              <span className="text-ink-faint">/</span>
            )}
            {i === segments.length - 1 ? (
              <span className="font-medium text-ink-strong">
                {seg.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setDir(seg.path)}
                className="rounded-sm text-ink-muted hover:text-ink-strong"
              >
                {seg.label}
              </button>
            )}
          </span>
        ))}
      </nav>

      <div className="px-4 py-2 border-b border-line-faint shrink-0 flex items-center gap-2">
        <Input
          size="sm"
          type="text"
          aria-label="筛选当前目录"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选当前目录"
          className="flex-1"
        />
        <label className="shrink-0 text-label text-ink-muted flex items-center gap-1.5 cursor-pointer select-none">
          <Checkbox
            checked={showHidden}
            onCheckedChange={(v) => setShowHidden(v === true)}
          />
          显示隐藏目录
        </label>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            setMkdirError(null);
            setNewName((n) => (n === null ? "" : null));
          }}
          disabled={!data || loading}
          title="在当前目录下新建文件夹"
        >
          <Icon icon={FolderPlus} size="sm" />
          新建文件夹
        </Button>
      </div>

      {newName !== null && data && (
        <div className="px-4 py-2 border-b border-line-faint shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-label text-ink-faint font-mono truncate max-w-[45%]">
              {prettifyHomeWith(data.path, data.home)}/
            </span>
            <Input
              type="text"
              aria-label="新文件夹名"
              value={newName}
              autoFocus
              disabled={mkdirBusy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createDir();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setNewName(null);
                }
              }}
              placeholder="新文件夹名"
              className="flex-1 font-mono"
            />
            <Button
              variant="primary"
              className="shrink-0"
              onClick={() => void createDir()}
              loading={mkdirBusy}
              disabled={!newName.trim() || mkdirBusy}
            >
              创建并使用
            </Button>
          </div>
          {!!mkdirError && (
            <ErrorCallout compact className="mt-1.5" error={mkdirError} title="新建文件夹失败" />
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && <SkeletonText lines={5} className="px-4 py-4" />}
        {!!error && (
          <div className="px-4 py-3">
            <ErrorCallout
              compact
              error={error}
              title="打不开这个目录"
              action={
                data && data.path !== dir ? (
                  <Button size="sm" onClick={() => setDir(data.path)}>
                    回到上次的位置
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
        {!loading && !error && data && (
          <>
            {data.parent && (
              <button
                onClick={() => setDir(data.parent)}
                className="w-full text-left px-4 py-2 flex items-center gap-3 text-ui text-ink-muted hover:bg-surface-hover border-b border-line-faint"
              >
                <Icon icon={ArrowUp} className="text-ink-faint" />
                <span className="truncate">上一级</span>
              </button>
            )}
            {filteredChildren.length === 0 ? (
              <div className="px-4 py-8 text-ui text-ink-muted text-center">
                {filter ? "没有匹配的子目录" : "这个目录下没有子目录"}
              </div>
            ) : (
              <ul>
                {filteredChildren.map((c) => {
                  const active = c.path === currentPath;
                  return (
                    <li key={c.path}>
                      <div
                        className={`w-full flex items-stretch border-b border-line-faint last:border-b-0 ${
                          active ? "bg-surface-muted" : ""
                        }`}
                      >
                        <button
                          onClick={() => setDir(c.path)}
                          className="flex-1 min-w-0 text-left px-4 py-2 flex items-center gap-3 hover:bg-surface-hover transition-colors"
                          title="进入这个目录"
                        >
                          <Icon icon={Folder} className="text-ink-faint" />
                          <span className="block text-ui text-ink truncate">
                            {c.name}
                          </span>
                          {active && (
                            <Badge variant="accent" className="ml-auto">
                              当前
                            </Badge>
                          )}
                        </button>
                        <button
                          onClick={() => onPick(c.path)}
                          className="px-3 text-label text-ink-muted hover:text-accent-ink hover:bg-surface-hover border-l border-line-faint transition-colors"
                          title="直接用这个目录当工作区"
                        >
                          选用
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.truncated && (
              <div className="px-4 py-2 text-label text-ink-faint">
                子目录太多，只显示了一部分；可以用上面的筛选框找
              </div>
            )}
          </>
        )}
      </div>

      {data && !loading && !error && (
        <div className="px-4 py-2 border-t border-line-faint shrink-0 flex items-center gap-2">
          <span className="text-label text-ink-muted font-mono truncate flex-1">
            {prettifyHomeWith(data.path, data.home)}
          </span>
          <Button
            variant="primary"
            className="shrink-0"
            onClick={() => onPick(data.path)}
          >
            使用这个目录
          </Button>
        </div>
      )}
    </>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

/** posix dirname，够用就好：这里的输入都是服务端给的绝对路径。 */
function dirname(p: string): string {
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  if (idx <= 0) return "/";
  return stripped.slice(0, idx);
}

function prettifyHome(p: string): string {
  if (typeof window === "undefined") return p;
  const m = p.match(/^\/Users\/[^/]+\/(.+)$/);
  return m ? `~/${m[1]}` : p;
}

function prettifyHomeWith(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

type Segment = { label: string; path: string };

function buildBreadcrumb(p: string, home: string): Segment[] {
  // If we're inside $HOME, collapse the home prefix into a single "~"
  // segment so the breadcrumb doesn't bury the meaningful path under
  // /Users/<user>/.
  const parts: Segment[] = [];
  if (p === home || p.startsWith(home + "/")) {
    parts.push({ label: "~", path: home });
    if (p !== home) {
      const rel = p.slice(home.length + 1);
      const tokens = rel.split("/").filter(Boolean);
      let acc = home;
      for (const t of tokens) {
        acc = acc + "/" + t;
        parts.push({ label: t, path: acc });
      }
    }
    return parts;
  }
  // Outside HOME: full absolute breadcrumb anchored at "/".
  parts.push({ label: "/", path: "/" });
  if (p !== "/") {
    const tokens = p.split("/").filter(Boolean);
    let acc = "";
    for (const t of tokens) {
      acc = acc + "/" + t;
      parts.push({ label: t, path: acc });
    }
  }
  return parts;
}
