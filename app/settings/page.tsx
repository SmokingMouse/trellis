"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// 设置页。目前只有「版本与更新」一块 —— 刻意不把主题/发送键/宽度这些偏好搬进来，
// 它们各自有语境化的入口（主题在 ThemeMenu、发送键在 composer 脚注、宽度在线性
// 视图顶栏），搬进来只是多一跳。这一页存在的理由是**更新**：它没有语境化的家，
// 又需要展示版本、落后的 commit、部署进度、失败日志，塞不进任何一个 popover。

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
  const [msg, setMsg] = useState<string | null>(null);
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
      setMsg(null);
      try {
        const r = await fetch("/api/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setMsg(d?.error ?? "操作失败");
        } else {
          setMsg("已开始，下面会实时显示进度");
          offlineSince.current = null;
        }
      } catch {
        setMsg("请求失败");
      } finally {
        setBusy(false);
        void load(false);
      }
    },
    [load],
  );

  const check = useCallback(async () => {
    setChecking(true);
    setMsg(null);
    await load(true);
    setChecking(false);
  }, [load]);

  const phase = st?.deploy?.phase ?? null;
  const showDeploy = st?.running || (phase && phase !== "idle" && phase !== "done");
  const repoOk = Boolean(st?.repo.dir);
  const canUpdate = repoOk && !st?.running && !busy;

  return (
    <div className="min-h-screen bg-surface-canvas text-ink-strong">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/"
            className="h-7 px-2.5 inline-flex items-center rounded-md border border-line text-label text-ink-muted hover:text-ink hover:bg-surface-muted"
          >
            ← 返回
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">设置</h1>
        </div>

        <section className="rounded-card border border-line bg-surface shadow-raise p-5">
          <h2 className="text-ui font-medium mb-4">版本与更新</h2>

          {loadError && (
            <div className="mb-4 rounded-md border border-warn-line bg-warn-muted px-3 py-2 text-label text-warn-ink">
              {loadError}
            </div>
          )}

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
            <div className="mb-4 rounded-md border border-warn-line bg-warn-muted px-3 py-2 text-label text-warn-ink">
              <div className="font-medium">无法从界面更新</div>
              <div className="mt-1">{st.repo.problem?.hint}</div>
              <div className="mt-1 text-nano opacity-80">
                原因：上线用的 release 是 `git archive` 导出的，里面没有 .git，
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
            <ul className="mb-4 rounded-md border border-line-faint divide-y divide-line-faint">
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
            <label className="mb-4 flex items-start gap-2 rounded-md border border-warn-line bg-warn-muted px-3 py-2 text-label text-warn-ink cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                有 {st.activeRuns} 个会话正在生成，更新会把它们全部中断。
                勾选表示知情并继续。
              </span>
            </label>
          )}

          {/* 动作 */}
          <div className="flex items-center gap-2">
            <button
              onClick={check}
              disabled={!repoOk || checking}
              className="h-8 px-3 rounded-md border border-line text-label text-ink-muted hover:text-ink hover:bg-surface-muted disabled:opacity-50"
            >
              {checking ? "检查中…" : "检查更新"}
            </button>
            <button
              onClick={() => post({ action: "update", ref: "origin/main", force })}
              disabled={!canUpdate || st?.behind === 0}
              className="h-8 px-3 rounded-md bg-accent text-ink-inverse text-label font-medium hover:opacity-90 disabled:opacity-50"
            >
              更新到最新
            </button>
            {st?.deploy?.previousSha && !st.running && (
              <button
                onClick={() => post({ action: "rollback" })}
                disabled={!canUpdate}
                className="h-8 px-3 rounded-md border border-line text-label text-ink-muted hover:text-ink hover:bg-surface-muted disabled:opacity-50"
                title={`回到 ${st.deploy.previousSha}`}
              >
                回滚
              </button>
            )}
            {msg && <span className="text-label text-ink-faint">{msg}</span>}
          </div>

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
                <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-surface-canvas border border-line-faint p-3 text-nano font-mono whitespace-pre-wrap">
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
    </div>
  );
}
