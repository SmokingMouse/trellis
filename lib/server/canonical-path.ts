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
 * 解析到物理路径（消符号链接）。
 *
 * **规范化本身绝不能变成新的失败源**：realpath 对不存在的路径会抛，而这条路上
 * 有大量「还没落盘 / 刚被删」的候选。所以抛了就退化 —— 先找最长的那段**存在**
 * 的祖先做 realpath，再把余下的段原样拼回（这样 $HOME 这层符号链接照样被消掉）；
 * 一个祖先都解不出来就退回 path.resolve 的绝对路径。
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
