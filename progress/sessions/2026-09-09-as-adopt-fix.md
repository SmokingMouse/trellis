# 外部线程收编返工（fj-as-adopt-fix-4fb3，交付待验收）

- P1-1：系统/非 git workspace 精确撞 cwd 时，使用「外部会话」独立归组 workspace，实际 cwd 留在 session.workspace_path，不移动已有会话。生产快照 ownership-exact 的 home、scratch 两项均 PASS。
- P2-1/2：只有 `.git` 文件/目录或 Herdr 已知 repo/worktree 参与最长根匹配；匹配与兜底插入均 realpath。fixture 补 git 标记并撤除旧的生产快照祖先注册清理，直接覆盖非 git `/private/tmp`、精确系统根、symlink 和最长根。
- P1-2/P2-3：列表发现新线程，线程通知标记变化；按已投影 nextSeq−1 增量 attach，合并同 ID items 保留历史。关闭、删除、stop 清理 turns/snapshots/summaries/dirty/attached。重连覆盖静默断线漏 turn，以及丢失终态通知后的状态恢复。
- 常驻 daemon 99 条线程，完整 1.5 秒窗口：旧 service 静止轮 1 list + 5 attach、1,788,954 B；修后 1 list + 0 attach + 0 通知、60,602 B。最初四轮长窗口都有真实通知，探针因没有静止样本 exit 1；保留该日志，采样延长至最多 40 轮且不改判据，第 4 轮满足预算。复现：契约 out/service-probe.ts after。
- 最终 `bunx tsc --noEmit` exit 0；`bun test` 274 pass / 0 fail；收编回归子进程新增归属、增量、重连、清理断言全通过。统一前缀独占 mobile-as-adopt/project/shadow/herdr 均 exit 0，重连补充后再次执行 adopt exit 0。
- 3496 真机生产库快照验收 exit 0：自建 sonnet 线程 `th_8274d463-35c6-4bc8-88c5-60a31a5d8f18`，cwd 与 sessionCwd 均 `/Users/smokingmouse`，归 trellis:external；主页续问成功，删除只解绑，最终仅关闭该临时线程。3471–3480、3496 无监听，公共锁不存在。
- 复核 P2-4 的重复返回已删除。P2-5 保留为已知限制：关闭显示/API 首关依赖最近扫描状态；输入前 thread/read 仍强校验关闭状态。backend=external 不支持 turn/start、attach 无历史 Turn/usage、通用空会话 hydrate 待查等原限制不变。首次同步仍需完整历史，缓存随尚在观察的历史量增长，关闭/删除后释放。
- 证据：主仓 `.fenjue/tasks/fj-as-adopt-fix-4fb3/out/result.md`、`service-probe-*.log/json`、`ownership-exact.log`、`adopt-regression-final.log`、`bun-test-final.log`、`mobile-*.log`、`live/live-proof.json`。公共锁等待不触碰其它坐席进程。
- Next：主控独立复核验收；未 push、PR 或部署。并行期仅新增本 session 文件，不改共享 progress dashboard。
