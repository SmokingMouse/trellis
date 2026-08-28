// 平台自感知（caller context）与平台 pack 的回归断言。
//
// 防的漂移有三处，任何一处断了都是「内置技能静默失效」——症状是平台内的
// agent 突然变回瞎子（whoami 说不在平台里 / 技能列表里没有 trellis:trellis-admin），
// 而 spawn 本身照常成功，没有任何报错：
//  ① modeToRunOptions 注入 TRELLIS_* env：三个 mode（纯 chat / enhanced / project）
//     都注；纯 chat 已有的 CLAUDE_CODE_EFFORT_LEVEL 不被覆盖；无 platform 不注；
//     TRELLIS_URL 只在 TRELLIS_PORT（gate 口）在场时注。
//  ② platformPackDir 物化：plugin.json + skills/<dir> symlink 指向内置技能根、
//     内容寻址幂等、TRELLIS_BUILTIN_SKILLS=off 整体摘除。
//  ③ trellisctl 的自指防护：wait / abort / ask --node 对「自己这个节点」硬拒，
//     whoami 在平台外如实报告。
//
// Run: bun --conditions react-server scripts/test-platform-context.ts

import fs from "node:fs";
import path from "node:path";
import { modeToRunOptions } from "@/lib/llm/sdk-adapter";
import { platformPackDir } from "@/lib/server/platform-pack";
import { builtinSkillsRoot } from "@/lib/server/skills";
import type { StreamRequest } from "@/lib/llm/types";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}`);
  }
}

const baseReq = (extra: Partial<StreamRequest> = {}): StreamRequest => ({
  history: [],
  question: "hi",
  ...extra,
});
const PLATFORM = { sessionId: "sess-1", nodeId: "node-1" };

// ---------------------------------------------------------------------------
// ① env 注入
// ---------------------------------------------------------------------------

delete process.env.TRELLIS_PORT;

{
  const o = modeToRunOptions("chat", "sonnet", baseReq({ platform: PLATFORM }));
  ok(o.env?.TRELLIS_ENV === "1", "纯 chat：注入 TRELLIS_ENV=1");
  ok(o.env?.TRELLIS_SESSION_ID === "sess-1", "纯 chat：注入 TRELLIS_SESSION_ID");
  ok(o.env?.TRELLIS_NODE_ID === "node-1", "纯 chat：注入 TRELLIS_NODE_ID");
  ok(
    o.env?.CLAUDE_CODE_EFFORT_LEVEL === "low",
    "纯 chat：合并不覆盖 —— CLAUDE_CODE_EFFORT_LEVEL 仍在",
  );
  ok(!("TRELLIS_URL" in (o.env ?? {})), "无 TRELLIS_PORT：不注 TRELLIS_URL（宁缺毋错）");
}

{
  const o = modeToRunOptions("chat", "sonnet", baseReq({ platform: PLATFORM, chatEnhanced: true }));
  ok(o.env?.TRELLIS_ENV === "1" && o.env?.TRELLIS_NODE_ID === "node-1", "enhanced chat：注入齐全");
}

{
  const o = modeToRunOptions("project", "sonnet", baseReq({ platform: PLATFORM, cwd: "/tmp" }));
  ok(o.env?.TRELLIS_ENV === "1" && o.env?.TRELLIS_SESSION_ID === "sess-1", "project：注入齐全");
}

{
  process.env.TRELLIS_PORT = "3456";
  const o = modeToRunOptions("project", "sonnet", baseReq({ platform: PLATFORM, cwd: "/tmp" }));
  ok(o.env?.TRELLIS_URL === "http://127.0.0.1:3456", "有 TRELLIS_PORT：TRELLIS_URL 指向 gate 口");
  delete process.env.TRELLIS_PORT;
}

{
  const o = modeToRunOptions("project", "sonnet", baseReq({ cwd: "/tmp" }));
  ok(!o.env?.TRELLIS_ENV, "无 platform（mock 等无节点语境）：不注入");
}

// ---------------------------------------------------------------------------
// ② 平台 pack 物化
// ---------------------------------------------------------------------------

{
  process.env.TRELLIS_BUILTIN_SKILLS = "off";
  ok(platformPackDir() === null, "TRELLIS_BUILTIN_SKILLS=off：整体摘除（null）");
  delete process.env.TRELLIS_BUILTIN_SKILLS;
}

{
  const dir = platformPackDir();
  ok(dir !== null, "平台 pack：物化成功（dev 下内置根 = <cwd>/skills）");
  if (dir) {
    const plugin = JSON.parse(
      fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    ok(plugin.name === "trellis", "平台 pack：plugin 名为 trellis（技能列出为 trellis:<dir>）");
    const link = path.join(dir, "skills", "trellis-admin");
    ok(fs.lstatSync(link).isSymbolicLink(), "平台 pack：trellis-admin 是 symlink（正文改动自动跟随）");
    ok(
      fs.realpathSync(link) === fs.realpathSync(path.join(builtinSkillsRoot(), "trellis-admin")),
      "平台 pack：symlink 指向内置技能根",
    );
    ok(
      fs.readFileSync(path.join(link, "SKILL.md"), "utf8").includes("trellis-admin"),
      "平台 pack：经 symlink 能读到 SKILL.md",
    );
    ok(platformPackDir() === dir, "平台 pack：内容寻址幂等（第二次命中同一目录）");
  }
}

// ---------------------------------------------------------------------------
// ③ trellisctl 自指防护（子进程冒烟）
// ---------------------------------------------------------------------------

const CTL = path.join(process.cwd(), "skills/trellis-admin/scripts/trellisctl.ts");
const selfEnv = {
  ...process.env,
  TRELLIS_ENV: "1",
  TRELLIS_SESSION_ID: "sess-self",
  TRELLIS_NODE_ID: "node-self",
} as Record<string, string>;

function runCtl(args: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(["bun", CTL, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

{
  const r = runCtl(["wait", "node-self"], selfEnv);
  ok(r.code === 1 && r.err.includes("自己"), "trellisctl：wait 自己节点被硬拒");
}
{
  const r = runCtl(["abort", "."], selfEnv);
  ok(r.code === 1 && r.err.includes("自己"), 'trellisctl：abort "."（=自己）被硬拒');
}
{
  const r = runCtl(["ask", "hi", "--node", "."], selfEnv);
  ok(r.code === 1 && r.err.includes("--session ."), "trellisctl：ask --node 自己 → 指路 --session .");
}
{
  const r = runCtl(["whoami"], { ...process.env, TRELLIS_ENV: "" } as Record<string, string>);
  ok(r.code === 0 && r.out.includes("不在 Trellis 会话里"), "trellisctl：平台外 whoami 如实报告");
}
{
  const r = runCtl(["whoami"], { ...selfEnv, TRELLIS_URL: "http://127.0.0.1:1" });
  ok(
    r.code === 0 && r.out.includes("node-self") && r.out.includes("API 未达"),
    "trellisctl：平台内 whoami 在 API 不可达时降级但仍报身份",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
