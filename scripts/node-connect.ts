#!/usr/bin/env bun
// 把本机 trellis 接入一个 hub（多机互联）。`make node-connect CONN='trellis://v1/...'`。
//
//   bun scripts/node-connect.ts <连接串>     兑换连接串，写 ~/.trellis/hub-node.json
//   bun scripts/node-connect.ts status       当前接入状态
//   bun scripts/node-connect.ts disconnect   断开（删配置文件）
//
// 写完文件就结束：正在跑的 server.ts 每 3s 看一次这个文件，自己连上 hub，
// 不需要重启服务。连接串在 hub 的「设置 → 机器互联 → 添加机器」里生成。

import {
  hubNodeFile,
  parseConnectionString,
  redeemConnectionString,
  removeHubNodeFile,
  resolveHubNodeConfig,
  writeHubNodeFile,
} from "../lib/hub-node-config";

const [arg] = process.argv.slice(2);

async function main(): Promise<number> {
  const current = resolveHubNodeConfig();
  if (!arg || arg === "status") {
    if (!current) console.log("未接入 hub");
    else console.log(`已接入 ${current.hubURL}，node 名 ${current.nodeName}（来源：${current.source === "env" ? "环境变量" : hubNodeFile()}）`);
    return 0;
  }
  if (arg === "disconnect") {
    if (current?.source === "env") {
      console.error("接入配置来自环境变量（TRELLIS_HUB_URL 等），请改服务定义");
      return 1;
    }
    console.log(removeHubNodeFile() ? "已断开（server.ts 会在 3s 内停掉隧道）" : "本来就没有接入");
    return 0;
  }
  if (current?.source === "env") {
    console.error("接入配置来自环境变量，文件配置不会生效；请先从服务定义里去掉 TRELLIS_HUB_URL 等变量");
    return 1;
  }
  const conn = parseConnectionString(arg);
  if (!conn) {
    console.error("连接串格式不对，应以 trellis://v1/ 开头");
    return 1;
  }
  const cfg = await redeemConnectionString(conn);
  writeHubNodeFile(cfg);
  console.log(`已接入 ${cfg.hubURL}，node 名 ${cfg.nodeName}`);
  console.log(`配置写在 ${hubNodeFile()}（0600）；trellis 服务在跑的话 3s 内自动连上`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
