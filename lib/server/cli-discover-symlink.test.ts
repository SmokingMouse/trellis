// 根因 C 的常驻回归：$HOME 是符号链接时，物理路径与符号路径必须等价。
//
// devbox 现场：$HOME=/home/zhangpeng.pada → /data00/home/zhangpeng.pada。
// herdr 侧 realpath 出物理路径喂给 attach，codex 枚举侧用 os.homedir() 拿到符号
// 路径，cli-lineage 精确串比较对不上 → 每次 attach 都抛，herdr-fleet 无限重试，
// prod /api/providers 7–16s。
//
// 夹具照 devbox 的形状造：tempdir 当「真实 HOME」，再 ln -s 一个别名目录指向它，
// 合成 codex rollout 放进真实 HOME，把**别名解析后的物理路径**喂进去。
//
// 必须走子进程：CODEX_HOME_DIR / PROJECTS_DIR 是模块级常量，在本进程里 cli-discover
// 早被别的用例按真实 $HOME 加载过了，改 env 也不会重算。
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "trellis-symlink-home-")),
);
const repoRoot = path.resolve(import.meta.dir, "..", "..");

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** 真实 HOME + 指向它的别名 HOME + 一个含 turn 的 codex rollout / claude jsonl。 */
function buildSymlinkedHome(name: string): {
  aliasHome: string;
  codexPhysical: string;
  claudePhysical: string;
} {
  const base = path.join(tempRoot, name);
  const realHome = path.join(base, "real-home");
  const aliasHome = path.join(base, "alias-home");
  fs.mkdirSync(realHome, { recursive: true });
  fs.symlinkSync(realHome, aliasHome);

  const sessionId = "01a0aaa2-1111-4111-8111-111111111111";
  const cwd = path.join(base, "project");
  fs.mkdirSync(cwd, { recursive: true });

  const codexDir = path.join(realHome, ".codex", "sessions", "2026", "09", "18");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPhysical = path.join(
    codexDir,
    `rollout-2026-09-18T10-00-00-${sessionId}.jsonl`,
  );
  fs.writeFileSync(
    codexPhysical,
    fs
      .readFileSync(
        path.join(import.meta.dir, "__fixtures__", "codex", "modern-response-items.jsonl"),
        "utf8",
      )
      .replaceAll("PROJECT", cwd),
  );

  const claudeDir = path.join(realHome, ".claude", "projects", "fixture-slug");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePhysical = path.join(claudeDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    claudePhysical,
    [
      { type: "user", uuid: "u1", parentUuid: null, sessionId, cwd, timestamp: "2026-09-18T10:00:00.000Z", message: { role: "user", content: "question" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId, cwd, timestamp: "2026-09-18T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  return { aliasHome, codexPhysical, claudePhysical };
}

function runWithSymlinkedHome(
  aliasHome: string,
  argv: string[],
  script: string,
): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(["bun", ...argv], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: aliasHome,
      CODEX_HOME: path.join(aliasHome, ".codex"),
      TRELLIS_REPO: repoRoot,
      TRELLIS_DB_PATH: path.join(aliasHome, "trellis.db"),
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      no_proxy: "*",
    },
    stdin: script ? new TextEncoder().encode(script) : undefined,
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

test("C 探针：符号链接 HOME 下物理路径与符号路径的 codex discoverLineage 等价", () => {
  const fixture = buildSymlinkedHome("probe");
  const run = runWithSymlinkedHome(
    fixture.aliasHome,
    ["test/scripts/probe-codex-symlink-path.ts", fixture.codexPhysical],
    "",
  );
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.stdout).toContain("PASS: 物理/符号路径等价");
});

test("符号链接 HOME + 物理路径：codex / claude 的 discoverLineage 都必须成功", () => {
  const fixture = buildSymlinkedHome("direct");
  const script = `
    import { mock } from "bun:test";
    mock.module("server-only", () => ({}));
    import assert from "node:assert/strict";
    import os from "node:os";
    import fs from "node:fs";
    const { discoverLineage } = await import(${JSON.stringify(path.join(repoRoot, "lib/server/cli-discover.ts"))});
    // 前置自检：这个子进程里 $HOME 确实是符号链接，否则用例毫无区分力。
    assert.notEqual(os.homedir(), fs.realpathSync(os.homedir()), "夹具的 HOME 不是符号链接");
    const codex = discoverLineage(${JSON.stringify(fixture.codexPhysical)}, "codex");
    assert.equal(codex.members.length, 1);
    assert.equal(codex.members[0].path, ${JSON.stringify(fixture.codexPhysical)});
    const claude = discoverLineage(${JSON.stringify(fixture.claudePhysical)}, "claude");
    assert.equal(claude.members.length, 1);
    assert.equal(claude.members[0].path, ${JSON.stringify(fixture.claudePhysical)});
    console.log("OK");
  `;
  const run = runWithSymlinkedHome(fixture.aliasHome, ["-"], script);
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.stdout).toContain("OK");
});
