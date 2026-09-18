// 文件系统路径的**唯一**规范化入口（根因 C）。
//
// 事故现场（BOE devbox）：$HOME=/home/zhangpeng.pada 是指向
// /data00/home/zhangpeng.pada 的符号链接。于是同一个 codex rollout 在进程里有两
// 个名字 —— herdr 侧经 realpath 拿到的**物理路径** /data00/...，而 codex-paths
// 的 os.homedir() 枚举出来的是**符号路径** /home/...。cli-lineage 用
// `f.full === selected` 这种精确串比较去找选中文件，两个名字永远对不上，于是
// 每次 attach 都抛「selected CLI jsonl has no parseable turns」，herdr-fleet 把
// 它当可重试错误无限重试，prod 的 /api/providers 被拖到 7–16s。
//
// 结论：凡是**要拿来互相比较**的路径，都必须先过这一个函数，绝不能一边 realpath
// 一边 homedir 原样。dev+inode 比较也能解这道题，但那要求两边都 stat 得到，且
// 没法当 Map key —— 统一成 canonical 串更便宜，也顺带治好了 DB 里存的路径。
import fs from "node:fs";
import path from "node:path";

/**
 * 解析到物理路径（消符号链接）——**路径等价规范化**，不是安全判据。
 *
 * **规范化本身绝不能变成新的失败源**：realpath 对不存在的路径会抛，而这条路上
 * 有大量「还没落盘 / 刚被删」的候选。所以抛了就退化 —— 先找最长的那段**存在**
 * 的祖先做 realpath，再把余下的段原样拼回（这样 $HOME 这层符号链接照样被消掉）；
 * 一个祖先都解不出来就退回 path.resolve 的绝对路径。
 *
 * 这份宽松只够用来当 Map key / DB 列值 / 去重键：拼回去的那一段**没有被证明**
 * 不是一个指向外面的符号链接。要判「在不在某个根里」必须用 {@link isWithinRoot}，
 * 别拿本函数的 fallback 串当物理证明（fail-open，见 root cause F1）。
 */
export function canonicalPath(value: string): string {
  const abs = path.resolve(value);
  try {
    return fs.realpathSync(abs);
  } catch {
    /* 往下走退化分支 */
  }
  const tail: string[] = [];
  let cursor = abs;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return abs; // 到根了还没解出来
    tail.unshift(path.basename(cursor));
    cursor = parent;
    try {
      return path.join(fs.realpathSync(cursor), ...tail);
    } catch {
      /* 这层也不存在，继续往上 */
    }
  }
}

// 一条路径上允许展开多少次符号链接。超了当成环 —— 判不出来就判不在根内。
const MAX_SYMLINK_HOPS = 40;

/**
 * 逐段走完一条路径，把**沿途每一个符号链接**换成它的目标，返回一条不含符号链接
 * 的绝对路径；判不出来（符号链接成环）返回 null。
 *
 * 和 realpath 的区别、也是它存在的唯一理由：判据取自符号链接的**目标**，用
 * `readlinkSync` 读链接自身的内容，所以
 *   - 目标不存在的 broken symlink 能拿到目标（realpath 直接 ENOENT），
 *   - 目标所在目录不可读的 symlink 也能拿到目标（realpath 抛 EACCES），
 * 两者都不再退化成「原样拼回」。反过来，**不存在的尾段**与**存在但 stat 不动的
 * 普通段**都按字面名字处理 —— 判据是「是不是符号链接、指向哪」，不是「读不读得
 * 到」，否则根内一个 chmod 000 的目录会把合法路径判成越界。
 */
function resolveSymlinkChain(value: string): string | null {
  const abs = path.resolve(value);
  const root = path.parse(abs).root;
  const pending = abs.slice(root.length).split(path.sep).filter(Boolean).reverse();
  let resolved = root;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.pop() as string;
    if (segment === ".") continue;
    if (segment === "..") {
      // resolved 一路都是消过符号链接的物理路径，所以 dirname 就是真正的父目录。
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, segment);
    let link: string | null = null;
    try {
      // lstat 不跟随：这一层是不是符号链接，只有它自己说了算。
      if (fs.lstatSync(next).isSymbolicLink()) link = fs.readlinkSync(next);
    } catch {
      link = null; // 不存在 / 这层读不动 → 当普通名字，继续往下走
    }
    if (link === null) {
      resolved = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) return null;
    // 目标自己也可能层层是符号链接（相对目标按**链接所在目录**解），整条重新入队。
    const target = path.resolve(resolved, link);
    const targetRoot = path.parse(target).root;
    for (const part of target
      .slice(targetRoot.length)
      .split(path.sep)
      .filter(Boolean)
      .reverse()) {
      pending.push(part);
    }
    resolved = targetRoot;
  }
  return resolved;
}

/**
 * 安全包含判断：candidate 实际落在 root 里面吗？
 *
 * 与 canonicalPath 严格分工 —— 那边是「两个名字指不指同一个东西」（宽松、不抛、
 * 可以退化），这边是「这个名字能不能逃出这个根」（严格、判不出就拒）。历史上
 * 两者混用过一个函数，于是 sessions 目录里一个 `broken → ../outside/x` 的
 * 符号链接被 canonicalPath 原样拼回成 sessions 内的路径，闸门直接放行（F1）。
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolveSymlinkChain(root) ?? canonicalPath(root);
  const resolved = resolveSymlinkChain(candidate);
  if (resolved === null) return false;
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
