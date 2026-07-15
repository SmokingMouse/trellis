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
  const { startContextBackfill } = await import(
    "./lib/server/context-backfill"
  );
  startContextBackfill();
  const { startCliSyncWatcher } = await import(
    "./lib/server/cli-sync-watcher"
  );
  startCliSyncWatcher();
}
