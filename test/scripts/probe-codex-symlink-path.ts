#!/usr/bin/env bun
/**
 * C 回归探针：codex discoverLineage 对「物理路径 vs 符号链接路径」必须等价。
 *
 * 背景（BOE devbox，$HOME=/home/... 是指向 /data00/home/... 的 symlink）：
 * herdr-fleet 用 realpathSync 传物理路径，codexFiles 用 os.homedir() 枚举出符号
 * 路径，cli-lineage 用精确字符串等值找 selected → 物理路径命中不了 → 误判
 * "selected CLI jsonl has no parseable turns"。
 *
 * 用法:
 *   bun test/scripts/probe-codex-symlink-path.ts <一个含 turn 的 codex rollout.jsonl 的物理路径>
 * 退出码：物理路径与符号路径结果一致 = 0；不一致（一个 throw 一个 OK）= 1。
 *
 * CI 接法建议：建 tempdir 作为「真实 HOME」，再 ln -s 一个别名目录指向它，把合成的
 * codex rollout（session_meta 带 payload.cwd + 至少一个真实 turn）放进真实 HOME，
 * 然后把【别名解析后的物理路径】传给本探针——这正是 devbox 的形状。
 */
import { mock } from "bun:test";
mock.module("server-only", () => ({}));
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error("need an existing codex rollout jsonl path");
  process.exit(2);
}

const repoRoot = process.env.TRELLIS_REPO || process.cwd();
const { discoverLineage } = await import(
  path.join(repoRoot, "lib/server/cli-discover.ts")
);

// 由物理路径反推一个「经 $HOME 符号前缀」的别名形；若本机 HOME 不是 symlink，
// 至少保证两形都 realpath 到同一文件（此时探针应天然通过，不具区分力，仅自检）。
const physical = fs.realpathSync(input);
const realHome = fs.realpathSync(os.homedir());
const symAlias =
  physical.startsWith(realHome + path.sep) && realHome !== os.homedir()
    ? path.join(os.homedir(), physical.slice(realHome.length + 1))
    : physical;

// **只比 ok 是不具区分力的**：cli-lineage 现在无条件先把 selected 放进结果
// （根因 D），所以「两形都没抛」在 canonical 失效时照样成立 —— 失效的表现是
// 符号形多出一个同一文件的第二身份（members=2），身份而非成败才是判据。
type Identity = {
  ok: boolean;
  detail: string;
  rootSid?: string;
  members?: string[];
};

function probe(p: string): Identity {
  try {
    const d = discoverLineage(p, "codex");
    // 动态 import 的返回是 any（路径是运行期拼的），这里显式标一下成员形状。
    const members = (d.members as { path: string }[])
      .map((m) => m.path)
      .sort();
    return {
      ok: true,
      detail: `rootSid=${d.rootSid.slice(0, 12)} members=${members.length} ${members.join(",")}`,
      rootSid: d.rootSid,
      members,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

const a = probe(physical);
const b = probe(symAlias);
console.log(`physical(${physical}) -> ${a.ok ? "OK" : "THROW"} ${a.detail}`);
console.log(`symlink (${symAlias}) -> ${b.ok ? "OK" : "THROW"} ${b.detail}`);

if (a.ok !== b.ok) {
  console.error("MISMATCH: 物理路径与符号链接路径不等价（根因 C 未修）");
  process.exit(1);
}
if (!a.ok) {
  console.error("两形都失败——夹具本身无 parseable turn，或存在别的问题");
  process.exit(1);
}
if (a.rootSid !== b.rootSid) {
  console.error(`MISMATCH rootSid: ${a.rootSid} vs ${b.rootSid}`);
  process.exit(1);
}
if (JSON.stringify(a.members) !== JSON.stringify(b.members)) {
  console.error(
    `MISMATCH members: ${JSON.stringify(a.members)} vs ${JSON.stringify(b.members)}`,
  );
  process.exit(1);
}
// 同一个文件只能有一个身份，且必须是物理形。
if (a.members?.length !== 1 || a.members[0] !== physical) {
  console.error(
    `MISMATCH identity: 期望单一成员 ${physical}，实得 ${JSON.stringify(a.members)}`,
  );
  process.exit(1);
}
console.log("PASS: 物理/符号路径等价");
