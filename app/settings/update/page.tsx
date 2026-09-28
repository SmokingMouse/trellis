"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleArrowUp, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import {
  Button,
  Checkbox,
  ErrorCallout,
  Icon,
  IconButton,
  PageHeader,
  SkeletonText,
  toast,
  useConfirm,
} from "@/components/ui";

// 管理台的「版本与更新」tab。曾经这一页就是整个 /settings，文件头写着「刻意不做偏好中心」
// —— S89 修订了那条取舍的一半：偏好仍不从原地控件搬走，但会在管理台多一份可穷举的镜像
// 清单（批 5），因为偏好从当年的几个涨到了 ~25 个、散在 8 个文件里。见
// decisions/2026-07-31-console-ia.md 决策 5。
//
// 更新本身进管理台的理由没变：它没有语境化的家，又要展示版本、落后的 commit、部署进度、
// 失败日志，塞不进任何一个 popover。

type Commit = { sha: string; subject: string };
type DeployPhase =
  | "idle" | "preflight" | "stage" | "install" | "build" | "smoke"
  | "backup" | "switch" | "verify" | "rollback" | "done" | "failed" | "broken";

type Status = {
  current: { sha: string; ref: string; builtAt: string; dir: string | null } | null;
  repo: { dir: string | null; problem: { kind: string; hint: string } | null };
  candidate: Commit | null;
  behind: number | null;
  commits: Commit[];
  deploy: {
    phase: DeployPhase;
    sha: string | null;
    previousSha: string | null;
    updatedAt: string;
    message: string;
  } | null;
  running: boolean;
  activeRuns: number;
  fetchError: string | null;
  logTail: string | null;
};

const PHASE_TEXT: Record<DeployPhase, string> = {
  idle: "空闲",
  preflight: "预检",
  stage: "导出新版本",
  install: "安装依赖",
  build: "构建",
  smoke: "预检新版本能不能跑",
  backup: "备份数据库",
  switch: "切换版本",
  verify: "验活",
  rollback: "回滚",
  done: "已完成",
  failed: "失败",
  broken: "失败且回滚未成功",
};
// 进度条用的顺序。rollback/failed/broken 不在其中——它们不是「更靠后」，是岔路。
const PHASE_ORDER: DeployPhase[] = [
  "preflight", "stage", "install", "build", "smoke", "backup", "switch", "verify", "done",
];

export default function SettingsPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const confirm = useConfirm();
  const [force, setForce] = useState(false);
  // 切换阶段服务会重启，轮询必然连续失败几次。用它区分「短暂重启」和「真的没了」。
  const [offline, setOffline] = useState(false);
  const offlineSince = useRef<number | null>(null);

  // 保持 .then 链而不是 async/await：setState 必须待在回调里，
  // react-hooks/set-state-in-effect 才不会把下面 effect 里的这次调用判成同步 setState。
  const load = useCallback((doFetch = false): Promise<void> => {
    return fetch(`/api/update${doFetch ? "?fetch=1" : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Status>;
      })
      .then((d) => {
        setSt(d);
        setLoadError(null);
        setOffline(false);
        offlineSince.current = null;
      })
      .catch(() => {
        // 部署切换时整个服务会重启 ~0.2s，网关出 503 维护页。这里失败是**预期**的，
        // 不该把页面打成错误态；连续失败超过 60s 才认为是真的出事了。
        if (offlineSince.current === null) offlineSince.current = Date.now();
        setOffline(true);
        if (Date.now() - offlineSince.current > 60_000) setLoadError("服务长时间无响应");
      });
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // 部署期间加密轮询，平时慢轮询（也能看到别人从命令行发起的部署）。
  const running = st?.running || offline;
  useEffect(() => {
    const id = setInterval(() => void load(false), running ? 1500 : 15_000);
    return () => clearInterval(id);
  }, [load, running]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const r = await fetch("/api/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          toast.error("操作没有开始", { description: d?.error ?? "服务端拒绝了这次请求" });
        } else {
          toast.success("已开始", { description: "下面会实时显示进度" });
          offlineSince.current = null;
        }
      } catch {
        toast.error("请求失败", { description: "连不上服务，稍后重试" });
      } finally {
        setBusy(false);
        void load(false);
      }
    },
    [load],
  );

  const check = useCallback(async () => {
    setChecking(true);
    await load(true);
    setChecking(false);
  }, [load]);

  const phase = st?.deploy?.phase ?? null;
  const showDeploy = st?.running || (phase && phase !== "idle" && phase !== "done");
  const repoOk = Boolean(st?.repo.dir);
  const canUpdate = repoOk && !st?.running && !busy;

  const rollback = async () => {
    const prev = st?.deploy?.previousSha;
    if (!prev) return;
    const ok = await confirm({
      title: "回滚到上一版？",
      description: `服务会切回 ${prev} 并短暂重启；正在生成的会话会被中断。`,
      confirmLabel: "回滚",
      danger: true,
    });
    if (ok) void post({ action: "rollback" });
  };

  const subtitle = st?.current ? (
    <>
      当前 <span className="font-mono">{st.current.sha}</span>
      {st.behind !== null && repoOk && (
        <>
          <span className="px-1.5 text-ink-faint">·</span>
          {st.behind === 0 ? "已是最新" : `落后 ${st.behind} 个提交`}
        </>
      )}
    </>
  ) : st ? (
    "当前版本未知"
  ) : undefined;

  return (
    // S89: 滚动容器与页头由 app/settings/layout.tsx 接管，这里只剩内容。
    <div className="flex flex-col gap-4">
        <PageHeader
          title="版本与更新"
          subtitle={subtitle}
          actions={
            <>
              <IconButton
                label="检查更新"
                onClick={check}
                disabled={!repoOk || checking}
              >
                <Icon icon={RefreshCw} className={checking ? "animate-spin" : undefined} />
              </IconButton>
              <Button
                variant="primary"
                onClick={() => post({ action: "update", ref: "origin/main", force })}
                disabled={!canUpdate || st?.behind === 0}
                loading={busy}
              >
                <Icon icon={CircleArrowUp} />
                更新到最新
              </Button>
            </>
          }
        />
        <section className="rounded-card border border-line bg-surface p-5">
          {loadError && (
            <ErrorCallout
              className="mb-4"
              error=""
              title="服务长时间无响应"
              hint="超过 60 秒没连上服务。页面仍在自动重试；若一直这样，去机器上看服务进程。"
              onRetry={() => void load(false)}
            />
          )}

          {!st && !loadError && <SkeletonText lines={3} className="mb-4" />}

          {/* 当前版本 */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui mb-4">
            <dt className="text-ink-muted">当前版本</dt>
            <dd className="font-mono">
              {st?.current?.sha ?? "未知"}
              {st?.current?.builtAt && (
                <span className="ml-2 font-sans text-label text-ink-faint">
                  {new Date(st.current.builtAt).toLocaleString("zh-CN")}
                </span>
              )}
            </dd>
            {st?.current?.ref && (
              <>
                <dt className="text-ink-muted">提交</dt>
                <dd className="truncate" title={st.current.ref}>{st.current.ref}</dd>
              </>
            )}
          </dl>

          {/* 仓库没配好时，把话说全：按钮为什么点不了、该往哪儿加什么 */}
          {!repoOk && st && (
            <div className="mb-4 rounded-card border border-warn-line bg-warn-muted px-3 py-2 text-label text-warn-ink">
              <div className="flex items-center gap-1.5 font-medium">
                <Icon icon={TriangleAlert} size="sm" />
                无法从界面更新
              </div>
              <div className="mt-1">{st.repo.problem?.hint}</div>
              <div className="mt-1 text-nano opacity-80">
                原因：上线用的版本包是 `git archive` 导出的，里面没有 .git，
                部署脚本只能在开发仓库里跑。
              </div>
            </div>
          )}

          {/* 更新状态 */}
          {repoOk && st && (
            <div className="mb-4 text-ui">
              {st.behind === null ? (
                <span className="text-ink-muted">
                  无法与仓库比较{st.fetchError ? `（${st.fetchError}）` : ""}
                </span>
              ) : st.behind === 0 ? (
                <span className="text-ink-muted">已是最新</span>
              ) : (
                <span>
                  落后 <span className="font-medium">{st.behind}</span> 个提交
                  {st.candidate && (
                    <span className="ml-2 font-mono text-label text-ink-faint">
                      → {st.candidate.sha}
                    </span>
                  )}
                </span>
              )}
              {st.fetchError && st.behind !== null && (
                <div className="mt-1 text-label text-ink-faint">
                  拉取远端失败（比较的是本地已有的 origin/main）：{st.fetchError}
                </div>
              )}
            </div>
          )}

          {/* 落后的 commit */}
          {st && st.commits.length > 0 && (
            <ul className="mb-4 rounded-card border border-line divide-y divide-line-faint">
              {st.commits.map((c) => (
                <li key={c.sha} className="px-3 py-1.5 text-label flex gap-3">
                  <span className="font-mono text-ink-faint shrink-0">{c.sha}</span>
                  <span className="truncate" title={c.subject}>{c.subject}</span>
                </li>
              ))}
            </ul>
          )}

          {/* 正在生成的会话 —— 切换会掐断它们，得先说清楚再让人勾 */}
          {st && st.activeRuns > 0 && !st.running && (
            <label className="mb-4 flex items-start gap-2 rounded-card border border-warn-line bg-warn-muted px-3 py-2 text-label text-warn-ink cursor-pointer">
              <Checkbox
                checked={force}
                onCheckedChange={(v) => setForce(v === true)}
                className="mt-0.5"
              />
              <span>
                有 {st.activeRuns} 个会话正在生成，更新会把它们全部中断。
                勾选表示知情并继续。
              </span>
            </label>
          )}

          {/* 动作：检查 / 更新在页头；回滚是低频的破坏性动作，留在这里并走确认框 */}
          {st?.deploy?.previousSha && !st.running && (
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={() => void rollback()} disabled={!canUpdate}>
                <Icon icon={Undo2} size="sm" />
                回滚到 <span className="font-mono">{st.deploy.previousSha}</span>
              </Button>
            </div>
          )}

          {/* 部署进度 */}
          {showDeploy && st?.deploy && (
            <div className="mt-5 pt-4 border-t border-line-faint">
              <div className="flex items-center gap-2 text-ui">
                <span
                  className={
                    phase === "failed" || phase === "broken"
                      ? "text-danger font-medium"
                      : "font-medium"
                  }
                >
                  {PHASE_TEXT[st.deploy.phase]}
                </span>
                <span className="text-label text-ink-faint truncate">
                  {st.deploy.message}
                </span>
              </div>

              {/* 阶段进度。走到 switch 时服务会重启 —— 先把话说在前面，
                  否则页面突然变维护页会像是崩了。 */}
              <div className="mt-2 flex gap-1">
                {PHASE_ORDER.map((p) => {
                  const cur = PHASE_ORDER.indexOf(st.deploy!.phase);
                  const i = PHASE_ORDER.indexOf(p);
                  const done = cur >= 0 && i <= cur;
                  return (
                    <div
                      key={p}
                      title={PHASE_TEXT[p]}
                      className={`h-1 flex-1 rounded-full ${done ? "bg-accent" : "bg-surface-muted"}`}
                    />
                  );
                })}
              </div>

              {offline && (
                <div className="mt-2 text-label text-ink-faint">
                  服务正在重启，页面会自动恢复（切换窗口实测约 0.2 秒）。
                </div>
              )}

              {st.logTail && (
                <pre className="mt-3 max-h-64 overflow-auto rounded-card bg-surface-canvas border border-line p-3 text-nano font-mono whitespace-pre-wrap">
                  {st.logTail}
                </pre>
              )}
            </div>
          )}

          <p className="mt-5 text-nano text-ink-faint leading-relaxed">
            更新会在别处构建好新版本、用真数据快照预检能不能跑，通过后才原子切换；
            验活不过自动回滚到上一版。整个过程只有切换那一下服务不可用。
          </p>
        </section>
    </div>
  );
}
