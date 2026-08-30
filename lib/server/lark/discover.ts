import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { getAgent } from "@/lib/server/agents";
import type { LarkBot } from "@/lib/lark-types";
import { testLarkCredentials } from "./sdk";
import {
  createLarkBot,
  getLarkBot,
  getLarkBotRecordByAppId,
  setLarkBotIdentity,
  updateLarkBot,
} from "./store";

export type DiscoveredCandidate = {
  appId: string;
  appSecret: string;
  source: string;
  sourceType: "feishu-cli" | "lark-cli" | "env" | "agent-gateway";
};

export type DiscoveredLarkBot = {
  appId: string;
  name: string;
  openId: string | null;
  source: string;
  sourceType: "feishu-cli" | "lark-cli" | "env" | "agent-gateway";
  online: boolean;
  error?: string;
  alreadyRegistered: boolean;
  registeredBotId: string | null;
  boundAgentId: string | null;
  boundAgentName: string | null;
  boundAgentSlug: string | null;
};

/** 扫描本机全部可能的飞书应用凭证（~/.feishu-cli、~/.lark-cli、环境变量等） */
export function discoverLocalLarkCredentials(): DiscoveredCandidate[] {
  const home = os.homedir();
  const rawList: DiscoveredCandidate[] = [];

  // 1. ~/.feishu-cli/*.yaml
  const feishuDir = path.join(home, ".feishu-cli");
  if (fs.existsSync(feishuDir)) {
    try {
      const files = fs.readdirSync(feishuDir);
      // 优先看 config.yaml 与 sm-config.yaml
      const sortedFiles = files.sort((a, b) => {
        if (a === "config.yaml") return -1;
        if (b === "config.yaml") return 1;
        if (a === "sm-config.yaml") return -1;
        if (b === "sm-config.yaml") return 1;
        return a.localeCompare(b);
      });

      for (const f of sortedFiles) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) {
          try {
            const raw = fs.readFileSync(path.join(feishuDir, f), "utf8");
            const parsed = YAML.parse(raw);
            if (parsed && typeof parsed === "object") {
              const appId = parsed.app_id || parsed.appId;
              const appSecret = parsed.app_secret || parsed.appSecret;
              if (typeof appId === "string" && typeof appSecret === "string" && appId.trim() && appSecret.trim()) {
                rawList.push({
                  appId: appId.trim(),
                  appSecret: appSecret.trim(),
                  source: `~/.feishu-cli/${f}`,
                  sourceType: "feishu-cli",
                });
              }
            }
          } catch {
            // ignore malformed files
          }
        }
      }
    } catch {
      // ignore directory access errors
    }
  }

  // 2. ~/.lark-cli/config.json
  const larkConfigFile = path.join(home, ".lark-cli", "config.json");
  if (fs.existsSync(larkConfigFile)) {
    try {
      const raw = fs.readFileSync(larkConfigFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.apps)) {
        for (const app of parsed.apps) {
          if (app && typeof app.appId === "string" && typeof app.appSecret === "string" && app.appId.trim() && app.appSecret.trim()) {
            rawList.push({
              appId: app.appId.trim(),
              appSecret: app.appSecret.trim(),
              source: "~/.lark-cli/config.json",
              sourceType: "lark-cli",
            });
          }
        }
      }
    } catch {
      // ignore malformed lark-cli config
    }
  }

  // 3. ~/.agent-gateway.env / ~/.trellis/shared/.env.local
  for (const envPath of [
    path.join(home, ".agent-gateway.env"),
    path.join(home, ".trellis", "shared", ".env.local"),
  ]) {
    if (fs.existsSync(envPath)) {
      try {
        const raw = fs.readFileSync(envPath, "utf8");
        const lines = raw.split("\n");
        let envAppId = "";
        let envAppSecret = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("FEISHU_APP_ID=") || trimmed.startsWith("LARK_APP_ID=")) {
            envAppId = trimmed.split("=")[1]?.replace(/^["']|["']$/g, "").trim() || "";
          }
          if (trimmed.startsWith("FEISHU_APP_SECRET=") || trimmed.startsWith("LARK_APP_SECRET=")) {
            envAppSecret = trimmed.split("=")[1]?.replace(/^["']|["']$/g, "").trim() || "";
          }
        }
        if (envAppId && envAppSecret) {
          rawList.push({
            appId: envAppId,
            appSecret: envAppSecret,
            source: envPath.replace(home, "~"),
            sourceType: "agent-gateway",
          });
        }
      } catch {
        // ignore
      }
    }
  }

  // 4. process.env
  const envAppId = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET;
  if (envAppId?.trim() && envAppSecret?.trim()) {
    rawList.push({
      appId: envAppId.trim(),
      appSecret: envAppSecret.trim(),
      source: "环境变量 (FEISHU_APP_ID)",
      sourceType: "env",
    });
  }

  // Deduplicate by appId, keeping first seen
  const seen = new Set<string>();
  const uniqueList: DiscoveredCandidate[] = [];
  for (const item of rawList) {
    if (!seen.has(item.appId)) {
      seen.add(item.appId);
      uniqueList.push(item);
    }
  }

  return uniqueList;
}

/** 探测本机所有凭证并获取飞书端真实机器人名称与注册状态 */
export async function getDiscoveredLarkBots(): Promise<DiscoveredLarkBot[]> {
  const candidates = discoverLocalLarkCredentials();
  const results: DiscoveredLarkBot[] = [];

  for (const c of candidates) {
    const existing = getLarkBotRecordByAppId(c.appId);
    let online = false;
    let botName = existing?.botName || existing?.name || c.appId;
    let openId = existing?.botOpenId || null;
    let errorMsg: string | undefined;

    try {
      const info = await testLarkCredentials(c.appId, c.appSecret);
      online = true;
      botName = info.name || botName;
      openId = info.openId;
      if (existing?.id) {
        setLarkBotIdentity(existing.id, openId, botName);
      }
    } catch (err) {
      online = false;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    let boundAgentName: string | null = null;
    let boundAgentSlug: string | null = null;
    if (existing?.agentId) {
      const agent = getAgent(existing.agentId);
      if (agent) {
        boundAgentName = agent.name;
        boundAgentSlug = agent.slug;
      }
    }

    results.push({
      appId: c.appId,
      name: botName,
      openId,
      source: c.source,
      sourceType: c.sourceType,
      online,
      error: errorMsg,
      alreadyRegistered: !!existing,
      registeredBotId: existing?.id ?? null,
      boundAgentId: existing?.agentId ?? null,
      boundAgentName,
      boundAgentSlug,
    });
  }

  return results;
}

/** 一键从本地发现的凭证中导入机器人并绑定到 Agent */
export async function importLocalLarkBot(args: {
  appId: string;
  name?: string | null;
  agentId?: string | null;
  workspacePath?: string | null;
}): Promise<{ bot: LarkBot; testedName: string; openId: string }> {
  const candidates = discoverLocalLarkCredentials();
  const candidate = candidates.find((c) => c.appId === args.appId.trim());
  if (!candidate) {
    throw new Error(`未在本地找到 App ID 为「${args.appId}」的飞书应用配置`);
  }

  // 1. 验证凭证并获取飞书端机器人身份
  const botInfo = await testLarkCredentials(candidate.appId, candidate.appSecret);
  const botName = args.name?.trim() || botInfo.name || "飞书机器人";

  // 2. 检查是否已登记
  const existing = getLarkBotRecordByAppId(candidate.appId);
  if (existing) {
    // 原位更新并绑定
    updateLarkBot(existing.id, {
      name: botName,
      appSecret: candidate.appSecret,
      agentId: args.agentId ?? null,
      workspacePath: args.workspacePath?.trim() || null,
      enabled: true,
    });
    setLarkBotIdentity(existing.id, botInfo.openId, botInfo.name);
    return {
      bot: getLarkBot(existing.id)!,
      testedName: botInfo.name,
      openId: botInfo.openId,
    };
  }

  // 新建机器人记录
  const created = createLarkBot({
    name: botName,
    appId: candidate.appId,
    appSecret: candidate.appSecret,
    agentId: args.agentId ?? null,
    workspacePath: args.workspacePath?.trim() || null,
    enabled: true,
  });
  setLarkBotIdentity(created.id, botInfo.openId, botInfo.name);
  return {
    bot: getLarkBot(created.id)!,
    testedName: botInfo.name,
    openId: botInfo.openId,
  };
}
