// 安全包含判断的常驻回归（F1）：isWithinCodexSessions 不能 fail-open。
//
// 旧实现把「路径等价规范化」当成了「安全证明」：canonicalPath 解不动一条路径时
// 会退化成「最长存在祖先的 realpath + 尾段原样拼回」，而拼回去的那一段完全可能
// 就是一个指向根外的符号链接。于是 sessions 目录里
//   broken → outside/not-created        （目标不存在，realpath ENOENT）
//   denied → outside/locked/secret.jsonl（outside/locked chmod 000，realpath EACCES）
// 两条越界 symlink 都被拼回成 sessions 内的原名，闸门直接放行。
//
// 六格里另外三格是**必须继续通过**的合法场景，判据一旦改成「解不动就拒」就会把
// 它们误杀：尾段还没落盘、中间层是留在根内的 symlink、根内合法的 EACCES。
// 判据按 symlink 的**目标**定，不按可读性定 —— 这三格就是这条规则的守卫。
//
// 必须走子进程：CODEX_SESSIONS_DIR 是模块级常量，本进程里 cli-discover 早被别的
// 用例按真实 $HOME 加载过了，改 env 不会重算。
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "trellis-boundary-")),
);
const repoRoot = path.resolve(import.meta.dir, "..", "..");

const realHome = path.join(tempRoot, "real");
const aliasHome = path.join(tempRoot, "alias");
const sessions = path.join(realHome, ".codex", "sessions");
const outside = path.join(tempRoot, "outside");
const lockedOutside = path.join(outside, "locked");
const lockedInside = path.join(sessions, "locked");

fs.mkdirSync(sessions, { recursive: true });
fs.symlinkSync(realHome, aliasHome);
fs.mkdirSync(outside);

// 中间层是留在根内的 symlink（日期目录被挪到同一根下的别处就是这形状）。
fs.mkdirSync(path.join(sessions, "physical"));
fs.symlinkSync(path.join(sessions, "physical"), path.join(sessions, "mid"));
// 三条越界 symlink：目标存在 / 目标不存在 / 目标所在目录不可读。
fs.symlinkSync(outside, path.join(sessions, "escape"));
fs.symlinkSync(path.join(outside, "not-created"), path.join(sessions, "broken"));
fs.mkdirSync(lockedOutside);
fs.writeFileSync(path.join(lockedOutside, "secret.jsonl"), "{}\n");
fs.symlinkSync(path.join(lockedOutside, "secret.jsonl"), path.join(sessions, "denied"));
// 根内合法但不可读的目录。
fs.mkdirSync(lockedInside);
fs.chmodSync(lockedOutside, 0);
fs.chmodSync(lockedInside, 0);

afterAll(() => {
  fs.chmodSync(lockedOutside, 0o700);
  fs.chmodSync(lockedInside, 0o700);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** chmod 000 对 root 不起作用；不是 root 时这必须真的抛 EACCES，否则两格没区分力。 */
function eaccesIsReal(): boolean {
  try {
    fs.realpathSync(path.join(sessions, "denied"));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EACCES";
  }
}

type Cell = { label: string; candidate: string; want: boolean };

const cells: Cell[] = [
  // 合法：尾段还没落盘（attach 会在文件刚建出来之前先问一次）。
  {
    label: "missing-tail",
    candidate: path.join(aliasHome, ".codex/sessions/not/yet.jsonl"),
    want: true,
  },
  // 合法：中间层是 symlink，但目标仍在根内。
  {
    label: "intermediate-inside",
    candidate: path.join(sessions, "mid/missing.jsonl"),
    want: true,
  },
  // 越界：目标存在且在根外（旧实现这格本来就对）。
  {
    label: "outside-live-target",
    candidate: path.join(sessions, "escape/missing.jsonl"),
    want: false,
  },
  // 越界：broken symlink —— 旧实现 fail-open 的第一格。
  { label: "outside-broken-target", candidate: path.join(sessions, "broken"), want: false },
  // 越界：目标目录 chmod 000 —— 旧实现 fail-open 的第二格。
  { label: "outside-EACCES-target", candidate: path.join(sessions, "denied"), want: false },
  // 合法：根内合法的 EACCES。判据若改成「读不到就拒」，这格会被误杀。
  {
    label: "inside-EACCES",
    candidate: path.join(aliasHome, ".codex/sessions/locked/no.jsonl"),
    want: true,
  },
];

test("isWithinCodexSessions：越界 symlink 一律拒、合法的解不动路径一律放行", () => {
  const skipEacces = !eaccesIsReal();
  expect(skipEacces, "非 root 下 chmod 000 必须真的产生 EACCES").toBe(
    process.getuid?.() === 0,
  );
  const table = cells.filter(
    (c) => !(skipEacces && c.label.includes("EACCES")),
  );
  const script = `
    import { mock } from "bun:test";
    mock.module("server-only", () => ({}));
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    const { isWithinCodexSessions } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/cli-discover.ts"))});
    assert.notEqual(os.homedir(), fs.realpathSync(os.homedir()), "夹具的 HOME 不是符号链接");
    const cells = ${JSON.stringify(table)};
    const bad = [];
    for (const cell of cells) {
      const accepted = isWithinCodexSessions(cell.candidate);
      console.log(JSON.stringify({ ...cell, accepted }));
      if (accepted !== cell.want) bad.push(cell.label);
    }
    assert.deepEqual(bad, [], "越界放行 / 合法误拒: " + bad.join(","));
    console.log("OK");
  `;
  const child = Bun.spawnSync(["bun", "-"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: aliasHome,
      CODEX_HOME: path.join(aliasHome, ".codex"),
      TRELLIS_REPO: repoRoot,
      TRELLIS_DB_PATH: path.join(tempRoot, "boundary.db"),
    },
    stdin: new TextEncoder().encode(script),
  });
  const out = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, out).toBe(0);
  expect(out).toContain("OK");
});
