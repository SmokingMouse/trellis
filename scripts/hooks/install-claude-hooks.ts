#!/usr/bin/env bun
// 把 Trellis 的 hook 条目幂等地装进 ~/.claude/settings.json。
//
//   bun scripts/hooks/install-claude-hooks.ts [--dry-run] [--uninstall] [--settings <path>]
//
// 三条硬纪律（都是踩过的坑）：
//
// 1. command 里的 $HOME **必须**保持字面量，由 sh 在运行时展开。Orca 早期把它
//    展开成了绝对路径写进文件，而 settings.json 跟着 dotfiles 跨机器走 ——
//    换一台用户名不同的机器，hook 静默失效（脚本路径不存在，`[ -x ]` 判假就
//    exit 0，连报错都没有）。
// 2. 文件里**别人的条目一条都不许动**（story / orca / 字节的 ai-report 都挂在
//    同一个 settings.json 上）。我们只按 command 全等认自己的条目。
// 3. 写之前先备份到 settings.json.bak-<时间戳>。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 装进 settings.json 的那一行。字面量 $HOME —— 见文件头第 1 条。 */
export const TRELLIS_HOOK_COMMAND =
  'if [ -x "$HOME/.trellis/hooks/trellis-hook.sh" ]; then /bin/sh "$HOME/.trellis/hooks/trellis-hook.sh"; fi';

export const HOOK_TIMEOUT_SECONDS = 10;

/** 要挂的事件。工具类事件带 matcher: "*"，会话/轮次类事件不带（对齐 Claude Code 的写法）。 */
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

const TOOL_SCOPED = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function groupFor(event: string): HookGroup {
  const group: HookGroup = {
    hooks: [
      { type: "command", command: TRELLIS_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS },
    ],
  };
  if (TOOL_SCOPED.has(event)) group.matcher = "*";
  return group;
}

function isOurs(entry: HookEntry): boolean {
  return entry?.command === TRELLIS_HOOK_COMMAND;
}

/** 沿用原文件的缩进宽度 —— 重排整个文件的格式等于把别人的条目也「改」了。 */
function detectIndent(raw: string): number {
  const m = raw.match(/\n([ ]+)"/);
  return m ? m[1].length : 2;
}

export type PlanResult = {
  next: Settings;
  changedEvents: string[];
  changed: boolean;
};

/** 追加：每个事件最多一条我们的 group，已在就跳过。纯函数，不碰磁盘。 */
export function planInstall(current: Settings): PlanResult {
  const next: Settings = structuredClone(current);
  const hooks: Record<string, HookGroup[]> = { ...(next.hooks ?? {}) };
  const changedEvents: string[] = [];

  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const already = groups.some((g) => (g?.hooks ?? []).some(isOurs));
    if (already) continue;
    groups.push(groupFor(event));
    hooks[event] = groups;
    changedEvents.push(event);
  }
  next.hooks = hooks;
  return { next, changedEvents, changed: changedEvents.length > 0 };
}

/** 卸载：只摘掉 command 全等我们那条的 entry，空掉的 group / 事件顺手清掉。 */
export function planUninstall(current: Settings): PlanResult {
  const next: Settings = structuredClone(current);
  const hooks: Record<string, HookGroup[]> = { ...(next.hooks ?? {}) };
  const changedEvents: string[] = [];

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let touched = false;
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      const remaining = entries.filter((e) => !isOurs(e));
      if (remaining.length === entries.length) {
        kept.push(group);
        continue;
      }
      touched = true;
      // 整组只剩空壳就别留了；组里还有别人的 entry 则原样保留其余字段。
      if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
    }
    if (!touched) continue;
    changedEvents.push(event);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  next.hooks = hooks;
  return { next, changedEvents, changed: changedEvents.length > 0 };
}

/**
 * 逐行 diff（LCS）。只给人看，不引依赖 —— settings.json 就几百行，O(n·m) 无所谓。
 * 贪心的「往后找下一个相同行」写法在这种大段重复的 JSON 上会错位成不闭合的片段，
 * 看着像文件要被写坏，白吓人一场。
 */
export function textDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

export type RunOptions = {
  settingsPath?: string;
  dryRun?: boolean;
  uninstall?: boolean;
};

export type RunResult = {
  settingsPath: string;
  changed: boolean;
  changedEvents: string[];
  diff: string;
  backup: string | null;
  wrote: boolean;
};

export function run(opts: RunOptions = {}): RunResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const exists = fs.existsSync(settingsPath);
  const raw = exists ? fs.readFileSync(settingsPath, "utf8") : "{}\n";

  let current: Settings;
  try {
    current = raw.trim() === "" ? {} : (JSON.parse(raw) as Settings);
  } catch (e) {
    throw new Error(`${settingsPath} 不是合法 JSON，拒绝改写：${String(e)}`);
  }

  const plan = opts.uninstall ? planUninstall(current) : planInstall(current);
  const indent = detectIndent(raw);
  const before = exists ? raw : "";
  const after = JSON.stringify(plan.next, null, indent) + "\n";
  const diff = plan.changed ? textDiff(before, after) : "";

  if (!plan.changed || opts.dryRun) {
    return {
      settingsPath,
      changed: plan.changed,
      changedEvents: plan.changedEvents,
      diff,
      backup: null,
      wrote: false,
    };
  }

  let backup: string | null = null;
  if (exists) {
    backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(settingsPath, backup);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, after);
  return {
    settingsPath,
    changed: true,
    changedEvents: plan.changedEvents,
    diff,
    backup,
    wrote: true,
  };
}

export function parseArgs(argv: string[]): RunOptions & { help: boolean } {
  const opts: RunOptions & { help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--settings") opts.settingsPath = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (opts.settingsPath === undefined && argv.includes("--settings")) {
    throw new Error("--settings 需要一个路径");
  }
  return opts;
}

const USAGE = `用法: bun scripts/hooks/install-claude-hooks.ts [选项]

  --dry-run          只打印 diff，不写文件
  --uninstall        只移除 trellis 自己的条目
  --settings <path>  指定 settings.json（默认 ~/.claude/settings.json）
`;

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const r = run(opts);
    const verb = opts.uninstall ? "移除" : "安装";
    if (!r.changed) {
      console.log(`[trellis-hooks] 无需改动（${verb}项已是目标状态）：${r.settingsPath}`);
      process.exit(0);
    }
    console.log(`[trellis-hooks] ${verb}事件：${r.changedEvents.join(", ")}`);
    console.log(r.diff);
    if (r.wrote) console.log(`[trellis-hooks] 已写入 ${r.settingsPath}${r.backup ? `（备份 ${r.backup}）` : ""}`);
    else console.log("[trellis-hooks] --dry-run：未写入");
  } catch (e) {
    console.error(`[trellis-hooks] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
