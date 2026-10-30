import fs from "node:fs";
import path from "node:path";

// 默认库（~/.trellis/data.db）就是 prod 库。getDB() 一打开就跑全部迁移，所以开发
// worktree 里的代码只要不带 TRELLIS_DB_PATH 碰它一下，还没上线的建表 / 数据迁移就
// 直接落进 prod，而 prod 还跑着旧代码。2026-10-30 实际发生过：角色 P2 集成时一条没带
// 隔离的命令把 P2 的建表和「管家迁成角色」提前跑进了 prod（agent 每次 shell 调用都是
// 新环境，上一条 export 的 TRELLIS_DB_PATH 下一条就没了）。
//
// 只拦「git 链接 worktree 里的代码 / 进程 → 真 prod 库」这一种组合：agent 干活都在
// 链接 worktree 里（根目录的 .git 是文件），事故也出在这里。prod 发布目录没有 .git、
// 主 checkout 的 .git 是目录，都照旧放行；只覆盖了 HOME 的隔离实例连的是临时库（旁边没有
// current / releases 这套发布布局），也放行。
// 真要拿 worktree 里的代码连 prod 库，显式设 TRELLIS_ALLOW_PROD_DB=1。

/** 从 dir 往上找第一个 .git，返回它是文件（链接 worktree）、目录（主 checkout）还是没有。 */
export function gitMarkerKind(dir: string): "file" | "dir" | null {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const st = fs.statSync(path.join(cur, ".git"));
      return st.isDirectory() ? "dir" : "file";
    } catch {
      /* 这一层没有 .git，继续往上 */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** dbPath 是不是一套部署出来的 trellis 家目录里的库（deploy.ts 的布局：同目录下有
 * current → releases/<ts>）。不用「家目录 + .trellis」去比：bun 的 os.homedir() 和
 * os.userInfo() 都跟着 HOME 走，只覆盖了 HOME 的隔离实例会被误认成 prod；而隔离实例的
 * 临时家目录里只有 data.db，没有这套发布布局。 */
export function isDeployedDb(dbPath: string): boolean {
  const dir = path.dirname(path.resolve(dbPath));
  return fs.existsSync(path.join(dir, "current")) || fs.existsSync(path.join(dir, "releases"));
}

/** 不该打开这个库时返回给人看的错误文案；允许时返回 null。 */
export function prodDbGuardError(opts: {
  /** 显式指定了库路径（TRELLIS_DB_PATH）就不管：调用方自己负责 */
  explicitDbPath: string | undefined;
  allowFlag: string | undefined;
  /** 进程工作目录与（能解析出来的）代码所在目录，任一在链接 worktree 里都算 */
  dirs: string[];
  dbPath: string;
  /** dbPath 是否在部署出来的 trellis 家目录里（isDeployedDb） */
  dbIsDeployed: boolean;
}): string | null {
  if (opts.explicitDbPath) return null;
  if (opts.allowFlag === "1") return null;
  if (!opts.dbIsDeployed) return null;
  const inWorktree = opts.dirs.find((d) => gitMarkerKind(d) === "file");
  if (!inWorktree) return null;
  return (
    `拒绝从 git worktree（${inWorktree}）打开 prod 库 ${opts.dbPath}：` +
    "打开就会把这份代码的迁移跑进 prod。请设 TRELLIS_DB_PATH 指向副本；" +
    "确实要连 prod 库就显式设 TRELLIS_ALLOW_PROD_DB=1。"
  );
}

/** getDB() 打开库之前调用；不允许时直接抛。codeDir = 调用方模块所在目录（解析不出就不传）。 */
export function assertProdDbAccessAllowed(dbPath: string, codeDir?: string): void {
  const dirs = [process.cwd()];
  if (codeDir && path.isAbsolute(codeDir) && fs.existsSync(codeDir)) dirs.push(codeDir);
  const err = prodDbGuardError({
    explicitDbPath: process.env.TRELLIS_DB_PATH,
    allowFlag: process.env.TRELLIS_ALLOW_PROD_DB,
    dirs,
    dbPath,
    dbIsDeployed: isDeployedDb(dbPath),
  });
  if (err) throw new Error(err);
}
