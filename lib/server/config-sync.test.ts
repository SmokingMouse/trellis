import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 配置同步（P4）：导出剔除密钥、dry-run 差异、冲突跳过 / 覆盖、技能路径穿越被拒。
// 同一进程里模拟两台机器：「来源」导出后改写本机状态充当「目标」再导入。
// DB / endpoints.yaml / 技能根全部指到临时目录，不碰真实 ~/.trellis、~/.claude、~/.config/sm。

mock.module("server-only", () => ({}));
const dir = fs.mkdtempSync(path.join(tmpdir(), "trellis-config-sync-"));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevEndpoints = process.env.SM_ENDPOINTS_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const yamlPath = path.join(dir, "endpoints.yaml");
const envFile = path.join(dir, "sm.env");
process.env.SM_ENDPOINTS_PATH = yamlPath;

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const sync = await import("./config-sync");
const { createAgent, getAgentBySlug, updateAgent } = await import("./agents");
const { grantApprovalRule } = await import("./approval-rules");
const { clearEndpointsCache } = await import("@smokingmouse/llm");
const { REDACTED } = await import("@/lib/config-sync");
type ConfigPackage = import("@/lib/config-sync").ConfigPackage;

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevEndpoints === undefined) delete process.env.SM_ENDPOINTS_PATH;
  else process.env.SM_ENDPOINTS_PATH = prevEndpoints;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeYaml(text: string) {
  fs.writeFileSync(yamlPath, text);
  clearEndpointsCache();
}

/** 走一遍 JSON 往返 + 校验，等同经浏览器转手。 */
function roundTrip(pkg: ConfigPackage): ConfigPackage {
  return sync.validatePackage(JSON.parse(JSON.stringify(pkg)));
}

const SOURCE_YAML = `
default: relay-model
env_file: ${envFile}
providers:
  claude:
    api_key_env: ANTHROPIC_API_KEY
    models: [opus]
  relay:
    api_key_env: RELAY_API_KEY
    anthropic_url: https://relay.example.com
    models:
      - relay-model
      - name: relay-big
        claude:
          env:
            ANTHROPIC_AUTH_TOKEN: sk-src-model-token
    claude:
      env:
        ANTHROPIC_AUTH_TOKEN: sk-src-provider-token
        MAX_THINKING_TOKENS: "8000"
      args: ["--api-key", "sk-src-arg", "--verbose"]
  basic:
    api_key_env: BASIC_API_KEY
    openai_url: https://user:sk-src-url@basic.example.com/v1
    models: [b1]
`;

describe("models：导出剔除密钥", () => {
  test("env / args / URL 凭证都打码，非密钥字段原样；env_file 的 key 值不出现", () => {
    fs.writeFileSync(envFile, "RELAY_API_KEY=sk-src-envfile\n");
    writeYaml(SOURCE_YAML);
    const pkg = sync.exportConfig({ kinds: ["models"], skillContent: true });
    const json = JSON.stringify(pkg);
    expect(json).not.toContain("sk-src");
    const relay = pkg.models!.find((m) => m.type === "provider" && m.name === "relay");
    expect(relay?.type).toBe("provider");
    if (relay?.type !== "provider") throw new Error("unreachable");
    const claude = relay.block.claude as { env: Record<string, string>; args: string[] };
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe(REDACTED);
    expect(claude.env.MAX_THINKING_TOKENS).toBe("8000");
    expect(claude.args).toEqual(["--api-key", REDACTED, "--verbose"]);
    expect(relay.block.api_key_env).toBe("RELAY_API_KEY");
    expect(relay.redacted).toContain("claude.env.ANTHROPIC_AUTH_TOKEN");
    expect(relay.redacted).toContain("models[1].claude.env.ANTHROPIC_AUTH_TOKEN");
    expect(pkg.models!.find((m) => m.type === "default")).toEqual({ type: "default", model: "relay-model" });
  });

  test("dry-run：目标保留自己的密钥；没有可沿用的值时提示 / 带凭证 URL 不可同步", () => {
    writeYaml(SOURCE_YAML);
    const pkg = roundTrip(sync.exportConfig({ kinds: ["models"], skillContent: true }));

    // 目标：claude 完全一样；relay 有自己的 token、模型列表不同；没有 basic；默认模型不同。
    fs.writeFileSync(envFile, "");
    writeYaml(`
default: opus
env_file: ${envFile}
providers:
  claude:
    api_key_env: ANTHROPIC_API_KEY
    models: [opus]
  relay:
    api_key_env: RELAY_API_KEY
    anthropic_url: https://relay.example.com
    models: [relay-model]
    claude:
      env:
        ANTHROPIC_AUTH_TOKEN: sk-target-own
      args: ["--api-key", "sk-target-arg"]
`);
    const items = sync.previewImport(pkg);
    const by = (key: string) => items.find((i) => i.kind === "models" && i.key === key)!;
    expect(by("provider:claude").status).toBe("same");
    expect(by("provider:relay").status).toBe("conflict");
    expect(by("provider:relay").changes).toEqual(["models", "claude"]);
    // relay 的模型级 token 目标没有 → 提示补；provider 级 token 用目标自己的，不提示
    expect(by("provider:relay").warnings.join("\n")).toContain("models[1].claude.env.ANTHROPIC_AUTH_TOKEN");
    expect(by("provider:relay").warnings.filter((w) => w.startsWith("claude.env."))).toEqual([]);
    expect(by("provider:relay").warnings.join("\n")).toContain("RELAY_API_KEY");
    expect(by("provider:basic").status).toBe("blocked");
    expect(by("default").status).toBe("conflict");

    // 覆盖 relay：写进去的是目标自己的 token，来源的密钥一个字都不落盘
    const results = sync.applyImport(pkg, [{ kind: "models", key: "provider:relay", overwrite: true }]);
    expect(results.find((r) => r.key === "provider:relay")?.outcome).toBe("overwritten");
    expect(results.find((r) => r.key === "default")?.outcome).toBe("skipped");
    const yaml = fs.readFileSync(yamlPath, "utf8");
    expect(yaml).toContain("sk-target-own");
    expect(yaml).toContain("sk-target-arg");
    expect(yaml).toContain("relay-big");
    expect(yaml).not.toContain("sk-src");
    expect(yaml).not.toContain(REDACTED);
    expect(yaml).toContain("default: opus");
  });
});

describe("agents：冲突跳过 / 覆盖", () => {
  test("新增 → 相同 → 冲突默认跳过 → 勾覆盖才覆盖；内置不导出", () => {
    createAgent({ slug: "sync-a", name: "同步 A", systemPrompt: "v1", skills: [{ kind: "host", name: "no-such-skill-xyz" }] });
    const pkg = roundTrip(sync.exportConfig({ kinds: ["agents"], skillContent: true }));
    expect(pkg.agents!.map((a) => a.slug)).toContain("sync-a");
    expect(pkg.agents!.some((a) => getAgentBySlug(a.slug)?.builtin)).toBe(false);

    // 目标上没有 → new，并提示缺技能
    const id = getAgentBySlug("sync-a")!.id;
    sqlite.getDB().prepare("DELETE FROM agents WHERE id = ?").run(id);
    let items = sync.previewImport(pkg);
    const a = items.find((i) => i.key === "sync-a")!;
    expect(a.status).toBe("new");
    expect(a.warnings.join()).toContain("no-such-skill-xyz");
    expect(sync.applyImport(pkg, null).find((r) => r.key === "sync-a")?.outcome).toBe("created");
    expect(sync.previewImport(pkg).find((i) => i.key === "sync-a")?.status).toBe("same");
    expect(sync.applyImport(pkg, null).find((r) => r.key === "sync-a")?.outcome).toBe("unchanged");

    // 目标改了提示词 → conflict
    updateAgent(getAgentBySlug("sync-a")!.id, { systemPrompt: "target-local" });
    items = sync.previewImport(pkg);
    expect(items.find((i) => i.key === "sync-a")).toMatchObject({ status: "conflict", changes: ["系统提示词"] });

    // 默认（不给 items）与勾选但不覆盖：都跳过
    expect(sync.applyImport(pkg, null).find((r) => r.key === "sync-a")?.outcome).toBe("skipped");
    expect(
      sync.applyImport(pkg, [{ kind: "agents", key: "sync-a", overwrite: false }]).find((r) => r.key === "sync-a")?.outcome,
    ).toBe("skipped");
    expect(getAgentBySlug("sync-a")!.systemPrompt).toBe("target-local");

    // 勾覆盖
    expect(
      sync.applyImport(pkg, [{ kind: "agents", key: "sync-a", overwrite: true }]).find((r) => r.key === "sync-a")?.outcome,
    ).toBe("overwritten");
    expect(getAgentBySlug("sync-a")!.systemPrompt).toBe("v1");
  });

  test("非法 slug 整包 400", () => {
    expect(() =>
      sync.validatePackage({ format: "trellis-config", version: 1, agents: [{ slug: "../x", name: "x" }] }),
    ).toThrow(sync.ConfigSyncInputError);
    expect(() => sync.validatePackage({ format: "trellis-config", version: 99 })).toThrow("请先更新目标机器");
  });
});

describe("approval-rules", () => {
  test("只导全局规则；目标已有 = 相同，没有 = 新增", () => {
    grantApprovalRule({ scope: "global", sessionId: "", interaction: { toolName: "mcp__x__y" } });
    const pkg = roundTrip(sync.exportConfig({ kinds: ["approval-rules"], skillContent: true }));
    expect(pkg.approvalRules).toEqual([{ toolKey: "mcp__x__y" }]);
    expect(sync.previewImport(pkg)[0].status).toBe("same");
    const fake = roundTrip({ ...pkg, approvalRules: [{ toolKey: "Bash" }, { toolKey: "AskUserQuestion" }] });
    const items = sync.previewImport(fake);
    expect(items.map((i) => i.status)).toEqual(["new", "blocked"]);
    sync.applyImport(fake, null);
    expect(sync.previewImport(fake)[0].status).toBe("same");
  });
});

describe("skills", () => {
  const src = path.join(dir, "src-skills");
  const dst = path.join(dir, "dst-skills");

  function mkSkill(root: string, name: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, name, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }

  test("导出剔除敏感文件与依赖目录；新增 → 相同 → 冲突覆盖时保留目标自己的 .env", () => {
    mkSkill(src, "demo", {
      "SKILL.md": "---\nname: demo\ndescription: 演示\n---\nbody",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      ".env": "DEMO_TOKEN=sk-skill-secret\n",
      "creds/credentials.json": '{"t":"sk-skill-secret"}',
      "node_modules/x/index.js": "x",
    });
    fs.chmodSync(path.join(src, "demo/scripts/run.sh"), 0o755);

    const pkg = roundTrip(sync.exportConfig({ kinds: ["skills"], skillContent: true }, { skillsRoot: src }));
    expect(JSON.stringify(pkg)).not.toContain("sk-skill-secret");
    const demo = pkg.skills!.find((s) => s.name === "demo")!;
    expect(demo.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(demo.excluded.sort()).toEqual([".env", "creds/credentials.json", "node_modules/"]);

    // 清单模式不带内容，但哈希一致，够预览用
    const manifest = sync.exportConfig({ kinds: ["skills"], skillContent: false }, { skillsRoot: src });
    expect(manifest.skills![0].files.every((f) => f.data === undefined)).toBe(true);
    expect(manifest.skills![0].hash).toBe(demo.hash);

    expect(sync.previewImport(pkg, { skillsRoot: dst })[0].status).toBe("new");
    // 清单包拿去应用：缺内容 → 失败，不写半个目录
    const failed = sync.applyImport(roundTrip(manifest), null, { skillsRoot: dst });
    expect(failed[0].outcome).toBe("failed");
    expect(fs.existsSync(path.join(dst, "demo"))).toBe(false);

    expect(sync.applyImport(pkg, null, { skillsRoot: dst })[0].outcome).toBe("created");
    expect(fs.statSync(path.join(dst, "demo/scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dst, "demo/.env"))).toBe(false);
    expect(sync.previewImport(pkg, { skillsRoot: dst })[0].status).toBe("same");

    // 目标有自己的 .env 和本地改动 → 冲突；覆盖后 .env 还在、本地改动被换掉
    fs.writeFileSync(path.join(dst, "demo/.env"), "DEMO_TOKEN=target-own\n");
    fs.writeFileSync(path.join(dst, "demo/local.txt"), "target only");
    const diff = sync.previewImport(pkg, { skillsRoot: dst })[0];
    expect(diff.status).toBe("conflict");
    expect(diff.changes).toEqual(["删除 1 个文件"]);
    expect(sync.applyImport(pkg, [{ kind: "skills", key: "demo" }], { skillsRoot: dst })[0].outcome).toBe("skipped");
    expect(
      sync.applyImport(pkg, [{ kind: "skills", key: "demo", overwrite: true }], { skillsRoot: dst })[0].outcome,
    ).toBe("overwritten");
    expect(fs.readFileSync(path.join(dst, "demo/.env"), "utf8")).toContain("target-own");
    expect(fs.existsSync(path.join(dst, "demo/local.txt"))).toBe(false);
    expect(fs.existsSync(`${dst}.trellis-sync`)).toBe(false);
  });

  test("路径穿越：校验阶段整包拒绝；绕过校验直接应用也写不出技能根", () => {
    const evil = (p: string) => ({
      format: "trellis-config",
      version: 1,
      skills: [{ name: "evil", hash: "", size: 1, excluded: [], files: [{ path: p, mode: 0o644, size: 1, sha256: "0".repeat(64), data: "eA==" }] }],
    });
    for (const p of ["../escape.txt", "a/../../escape.txt", "/etc/passwd", "a\\..\\b", "./SKILL.md", "a//b"]) {
      expect(() => sync.validatePackage(evil(p))).toThrow(sync.ConfigSyncInputError);
    }
    expect(() =>
      sync.validatePackage({ format: "trellis-config", version: 1, skills: [{ name: "..", files: [] }] }),
    ).toThrow(sync.ConfigSyncInputError);

    // 绕过 validatePackage（例如未来某个调用方忘了校验）：applySkill 自己也拒
    const forged = evil("../escape.txt") as unknown as ConfigPackage;
    const r = sync.applyImport(forged, null, { skillsRoot: dst });
    expect(r[0].outcome).toBe("failed");
    expect(fs.existsSync(path.join(dir, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dst, "escape.txt"))).toBe(false);
  });

  test("目标是软链（外部管理）的技能不覆盖", () => {
    const ext = path.join(dir, "external-linked");
    mkSkill(ext, "linked", { "SKILL.md": "---\nname: linked\n---\nexternal" });
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(path.join(ext, "linked"), path.join(dst, "linked"));
    mkSkill(src, "linked", { "SKILL.md": "---\nname: linked\n---\nfrom source" });
    const pkg = roundTrip(sync.exportConfig({ kinds: ["skills"], skillNames: ["linked"], skillContent: true }, { skillsRoot: src }));
    expect(sync.previewImport(pkg, { skillsRoot: dst })[0].status).toBe("blocked");
    sync.applyImport(pkg, [{ kind: "skills", key: "linked", overwrite: true }], { skillsRoot: dst });
    expect(fs.readFileSync(path.join(ext, "linked/SKILL.md"), "utf8")).toContain("external");
  });
});
