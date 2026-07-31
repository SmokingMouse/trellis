"use client";
import { useEffect, useState } from "react";

// S88: `@slug` 补全 —— 把某一轮定向丢给某个 Agent 跑（单轮，主线人格不变）。
//
// 与 `/` 那两个匹配器（useSkillSuggestions / lib/commands.ts:matchCommands）
// **正则互斥**：那两个都硬绑开头的 `/`，这里硬绑开头的 `@`，永不同时命中。
//
// **只解析开头的 @** 是刻意限制：句中提及（「帮我看看这个 @zoro」）要处理转义、
// 多提及、以及邮箱 / handle / 装饰器的误触，复杂度爆炸，而且与「这一轮定向派给谁」
// 的语义不符 —— 定向应该是显式的第一个 token。

export type MentionAgent = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

const MENTION_RE = /^@([^\s]*)$/;

export function useAgentMentions(
  text: string,
  enabled: boolean,
): MentionAgent[] {
  const [agents, setAgents] = useState<MentionAgent[]>([]);
  useEffect(() => {
    if (!enabled || agents.length) return;
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, [enabled, agents.length]);

  if (!enabled) return [];
  const m = MENTION_RE.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return agents
    .filter(
      (a) => a.slug.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    )
    .slice(0, 6);
}

/** 从输入文本里剥出开头的 `@slug `，返回 [slug, 剩余正文]。
 * 没有提及时返回 [null, 原文]。发送前调用 —— slug 走 body 字段，正文才是问题。 */
export function splitMention(text: string): [string | null, string] {
  const m = /^@([a-z0-9][a-z0-9-]{0,31})\s+([\s\S]+)$/.exec(text.trim());
  return m ? [m[1], m[2]] : [null, text];
}
