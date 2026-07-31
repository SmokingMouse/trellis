// Next server 启动钩子（register 每进程跑一次，在处理首个请求前）。
// 用来拉起 CLI session 同步 watcher（Stage B，progress/cli-sync.md）。
// 仅 nodejs runtime——watcher 用 fs + bun:sqlite，edge runtime 没有。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Env 卫生：从启动 shell 继承的交互式 CLI 调优变量不该穿透给 trellis spawn 的
  // claude（SDK 的 streamLines 用 {...process.env, ...opts.env} 合并）。实测踩坑：
  // 从 occ alias（CLAUDE_CODE_EFFORT_LEVEL=max）的 session 里启动 dev server →
  // spawn 出的 claude 进入分钟级 extended thinking，chat 模式看起来"卡死"。
  // trellis 的 effort 应由自己决定（当前 = CLI 默认，不设）；将来要 per-session
  // effort 再走 RunOptions.env 显式下发。
  if (process.env.CLAUDE_CODE_EFFORT_LEVEL) {
    console.warn(
      `[trellis] scrubbed inherited CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} from process env (interactive-shell tunable; would leak into spawned claude)`,
    );
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  }
  // S1：把存量 session 按目录归进 Project/Workspace。放这里而不是 sqlite.ts 的
  // migrate()，是因为它要 spawn git —— migrate() 至今是纯 SQL，别把子进程塞进去。
  // 幂等 + 整段吞异常，失败只是「没归组」，不拦启动。
  const { backfillWorkspaces } = await import("./lib/server/workspaces");
  const filled = backfillWorkspaces();
  if (filled.sessions > 0) {
    console.log(
      `[trellis] workspace backfill: ${filled.sessions} session(s) across ${filled.paths} dir(s)`,
    );
  }
  const { startContextBackfill } = await import(
    "./lib/server/context-backfill"
  );
  startContextBackfill();
  const { startCliSyncWatcher } = await import(
    "./lib/server/cli-sync-watcher"
  );
  startCliSyncWatcher();
  // S88：自定义 Agent 的 SDK 能力探测。放在调度器之前 —— SDK 版本不对时，多传的
  // RunOptions 字段会被 TS 的结构类型放过、被运行时**静默丢弃**：agent 完全不生效，
  // 但 spawn 正常、回答正常、零报错。这是整套里最难查的一类故障，必须在启动时喊。
  try {
    const { ClaudeBackend } = await import("@smokingmouse/agent");
    const caps = new ClaudeBackend().capabilities() as { customAgents?: boolean };
    if (!caps.customAgents) {
      console.error(
        "[trellis] ⚠️ @smokingmouse/agent 版本过低（缺 customAgents）——自定义 Agent 的" +
          "人设/工具/技能会被静默忽略。dev 下跑 `make link-sdk`；上线前需先发布新版 SDK。",
      );
    }
  } catch {
    /* 探测失败不拦启动 */
  }
  const { installDefaultChannels } = await import("./lib/server/notify");
  installDefaultChannels();
  const { startTaskScheduler } = await import("./lib/server/task-scheduler");
  startTaskScheduler();
}
