import "server-only";
import path from "node:path";
import { builtinSkillsRoot } from "./skills";

// 角色 P2：追加在角色记忆说明后面的「后台任务」说明（roleSpawnExtras 拼进 --append-system-prompt）。
//
// 为什么要专门说：claude -p 一轮结束就杀掉 run_in_background 的 Bash / 异步子 agent，
// 角色说「我在后台慢慢看」而用了它们，活会悄悄死掉。真正能独立跑完的是平台内
// `trellisctl ask --new` 开的一条普通会话；它带上 originNodeId，角色时间线就会出一张任务卡。

export function roleBackgroundTaskHint(): string {
  const ctl = path.join(builtinSkillsRoot(), "trellis-admin", "scripts", "trellisctl.ts");
  return [
    `## 后台任务`,
    ``,
    `活很大（要读几十个文件、跑很久）时，别在这一轮里硬干，也别用 run_in_background 或异步子 agent —— 这一轮结束它们就会被杀掉。改成开一个后台任务：`,
    ``,
    "```bash",
    `bun ${ctl} ask "<完整、自足的任务说明>" --new --workspace <工作目录>`,
    "```",
    ``,
    `它会在一条独立会话里跑完，用户在你的时间线里会看到一张任务卡、点开能看全过程。开完告诉用户你开了什么，不要等它跑完。`,
  ].join("\n");
}
