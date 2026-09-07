// 全部在临时目录上跑 —— 绝不碰真实的 ~/.claude/settings.json。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOOK_EVENTS,
  TRELLIS_HOOK_COMMAND,
  parseArgs,
  planInstall,
  run,
} from "./install-claude-hooks";

let dir: string;
let settings: string;

/** 别人的条目：story（无 matcher）、orca（带 matcher）、字节的 ai-report。 */
const FOREIGN = {
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command:
            "sh -c 'if ! command -v story >/dev/null 2>&1; then exit 0; fi; exec story hooks claude-code session-start'",
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command:
            'if [ -x "$HOME/.orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "$HOME/.orca/agent-hooks/claude-hook.sh"; fi',
          timeout: 10,
        },
      ],
    },
    {
      matcher: "Write|Edit|Bash",
      hooks: [{ type: "command", command: "exec ai-report-hook-run preToolUse", timeout: 30 }],
    },
  ],
};

function write(obj: unknown) {
  writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n");
}

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(settings, "utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "trellis-hook-installer-"));
  settings = path.join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("安装", () => {
  test("11 个事件全挂上，command 是固定字面量", () => {
    write({ model: "opus", hooks: {} });
    const r = run({ settingsPath: settings });
    expect(r.wrote).toBe(true);
    expect(r.changedEvents).toEqual([...HOOK_EVENTS]);

    const hooks = read().hooks as Record<string, { hooks: { command: string }[] }[]>;
    for (const event of HOOK_EVENTS) {
      const commands = hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands).toContain(TRELLIS_HOOK_COMMAND);
    }
  });

  test("$HOME 保持字面量，绝不展开成绝对路径", () => {
    write({});
    run({ settingsPath: settings });
    const raw = readFileSync(settings, "utf8");
    expect(raw).toContain('$HOME/.trellis/hooks/trellis-hook.sh');
    // 换台机器 home 变了照样成立 —— 文件里不许出现本机 home
    expect(raw).not.toContain(process.env.HOME ?? "/Users");
  });

  test("工具类事件带 matcher:*，会话/轮次类不带", () => {
    write({});
    run({ settingsPath: settings });
    const hooks = read().hooks as Record<string, { matcher?: string }[]>;
    expect(hooks.PreToolUse[0].matcher).toBe("*");
    expect(hooks.PermissionRequest[0].matcher).toBe("*");
    expect(hooks.Stop[0].matcher).toBeUndefined();
    expect(hooks.SessionStart[0].matcher).toBeUndefined();
  });

  test("幂等：跑第二遍不改任何东西", () => {
    write({ hooks: {} });
    run({ settingsPath: settings });
    const first = readFileSync(settings, "utf8");

    const second = run({ settingsPath: settings });
    expect(second.changed).toBe(false);
    expect(second.wrote).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(first);
    // 第二遍没改动 = 不该再生成备份
    expect(readdirSync(dir).filter((f) => f.includes(".bak-")).length).toBe(1);
  });

  test("别人的条目一条不动（含 orca 的）", () => {
    write({ model: "opus", permissions: { allow: ["Bash"] }, hooks: FOREIGN });
    run({ settingsPath: settings });

    const after = read();
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash"] });

    const hooks = after.hooks as Record<string, unknown[]>;
    // 原有的 group 原样在最前面，我们的追加在后
    expect(hooks.SessionStart[0]).toEqual(FOREIGN.SessionStart[0]);
    expect(hooks.PreToolUse[0]).toEqual(FOREIGN.PreToolUse[0]);
    expect(hooks.PreToolUse[1]).toEqual(FOREIGN.PreToolUse[1]);
    expect(hooks.PreToolUse.length).toBe(3);
  });

  test("settings.json 不存在时也能装（不备份，建目录）", () => {
    const nested = path.join(dir, "fresh", "settings.json");
    const r = run({ settingsPath: nested });
    expect(r.wrote).toBe(true);
    expect(r.backup).toBeNull();
    expect(JSON.parse(readFileSync(nested, "utf8")).hooks.Stop).toBeTruthy();
  });

  test("写前备份到同目录 settings.json.bak-<时间戳>", () => {
    write({ hooks: FOREIGN });
    const before = readFileSync(settings, "utf8");
    const r = run({ settingsPath: settings });
    expect(r.backup).toMatch(/settings\.json\.bak-/);
    expect(path.dirname(r.backup!)).toBe(dir);
    expect(readFileSync(r.backup!, "utf8")).toBe(before);
  });

  test("坏 JSON 直接拒绝，不写不备份", () => {
    writeFileSync(settings, "{ 这不是 json");
    expect(() => run({ settingsPath: settings })).toThrow(/不是合法 JSON/);
    expect(readFileSync(settings, "utf8")).toBe("{ 这不是 json");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("--dry-run", () => {
  test("只出 diff，不落盘、不备份", () => {
    write({ hooks: FOREIGN });
    const before = readFileSync(settings, "utf8");
    const r = run({ settingsPath: settings, dryRun: true });

    expect(r.changed).toBe(true);
    expect(r.wrote).toBe(false);
    expect(r.backup).toBeNull();
    // diff 里的 command 是 JSON 转义后的样子
    expect(r.diff).toContain(JSON.stringify(TRELLIS_HOOK_COMMAND));
    expect(r.diff.split("\n").every((l) => l.startsWith("+ ") || l.startsWith("- "))).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("--uninstall", () => {
  test("只摘自己的条目，别人的原样留下", () => {
    write({ model: "opus", hooks: FOREIGN });
    run({ settingsPath: settings });
    const r = run({ settingsPath: settings, uninstall: true });
    expect(r.wrote).toBe(true);

    const after = read();
    expect(after.model).toBe("opus");
    const hooks = after.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toEqual(FOREIGN.SessionStart);
    expect(hooks.PreToolUse).toEqual(FOREIGN.PreToolUse);
    // 只有我们挂过的事件（别人没条目的）被整个清掉
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.SubagentStart).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("trellis-hook.sh");
  });

  test("同一 group 里混着别人的 entry 时只摘我们那条", () => {
    write({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "别人的", timeout: 5 },
              { type: "command", command: TRELLIS_HOOK_COMMAND, timeout: 10 },
            ],
          },
        ],
      },
    });
    run({ settingsPath: settings, uninstall: true });
    const hooks = read().hooks as Record<string, { hooks: unknown[] }[]>;
    expect(hooks.Stop[0].hooks).toEqual([{ type: "command", command: "别人的", timeout: 5 }]);
  });

  test("没装过时是 no-op", () => {
    write({ hooks: FOREIGN });
    const before = readFileSync(settings, "utf8");
    const r = run({ settingsPath: settings, uninstall: true });
    expect(r.changed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  test("uninstall → install 能回到原状（可逆）", () => {
    write({ hooks: FOREIGN });
    run({ settingsPath: settings });
    const installed = read();
    run({ settingsPath: settings, uninstall: true });
    run({ settingsPath: settings });
    expect(read()).toEqual(installed);
  });
});

describe("参数解析", () => {
  test("认 --dry-run / --uninstall / --settings", () => {
    expect(parseArgs(["--dry-run", "--settings", "/tmp/x.json"])).toMatchObject({
      dryRun: true,
      settingsPath: "/tmp/x.json",
    });
    expect(parseArgs(["--uninstall"])).toMatchObject({ uninstall: true });
    expect(parseArgs([])).toEqual({ help: false });
  });

  test("未知参数报错（别默默改错文件）", () => {
    expect(() => parseArgs(["--force"])).toThrow(/未知参数/);
    expect(() => parseArgs(["--settings"])).toThrow(/需要一个路径/);
  });
});

describe("planInstall 是纯函数", () => {
  test("不改入参", () => {
    const input = { hooks: { Stop: [] } };
    const snapshot = JSON.stringify(input);
    planInstall(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
