// Next server 启动钩子（register 每进程跑一次，在处理首个请求前）。
// 用来拉起 CLI session 同步 watcher（Stage B，progress/cli-sync.md）。
// 仅 nodejs runtime——watcher 用 fs + better-sqlite3，edge runtime 没有。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startContextBackfill } = await import(
    "./lib/server/context-backfill"
  );
  startContextBackfill();
  const { startCliSyncWatcher } = await import(
    "./lib/server/cli-sync-watcher"
  );
  startCliSyncWatcher();
}
