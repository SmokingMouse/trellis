# cards-trellis：任务推送支持 Card 2.0 JSON 直通

## 背景
号池巡检 / 日报两个定时任务的 agent 最终答复将改成**完整的飞书 Card 2.0 JSON**（由确定性脚本生成，lark-card 技能设计）。现在 trellis 任务推送一律把最终答复当 markdown 经 `buildLarkCard` 转卡片，JSON 会被当正文发出去。需要：最终答复是卡片 JSON 时原样作为 interactive 卡片发送。

## 要做
1. `lib/server/lark/` 新增纯函数（建议放 `final-answer.ts` 或新文件）`parseCardPassthrough(text): FeishuCardV2 | null`：
   - 允许首尾空白，允许整段被 ```json … ``` 或 ``` … ``` 代码块包裹（LLM 常这么包）；
   - 解析成功且是对象、`schema === "2.0"`、`body.elements` 是数组 → 返回该对象；否则 null；
   - 序列化后 UTF-8 字节 > `CARD_MAX_BYTES`（card.ts，24KB）→ null（走原 markdown 路径）。
2. `sendLarkText`（sdk.ts）新增可选参数 `card?: FeishuCardV2`：给了就跳过 `buildLarkCard` 直接用它；其余逻辑（reply/create、失败降级 text）不变。降级 text 用 `textFallback`。
3. `pushTaskRunToLark`（push.ts）：`parseCardPassthrough(args.markdown)` 命中时——传 `card`，不传 `title/status`（卡片自带 header），`textFallback` 用卡片的 `config.summary.content`，没有则 header.title.content，再没有则「（卡片消息）」；未命中时行为完全不变。
4. `taskLarkPushContent` 的 `[SILENT]` / 空答复门控不变（卡片 JSON 是非空答复，照推）。
5. 入站回复（handler.ts runAgentTurn）**不改**。

## 约束
- 只改 lib/server/lark/ 下相关文件与测试；不动 access 相关代码、不动 .fenjue/**；不 push、不 make deploy、不碰 ~/.trellis/data.db。
- 测试（bun test）：parseCardPassthrough 覆盖 裸 JSON / ```json 包裹 / 非 2.0 / 非对象 / 超 24KB / 普通 markdown；push 用 deps 注入断言命中时 sendText 收到 card 且无 title、textFallback=summary，未命中时与现在一致。
- 注释中文，风格跟随所在文件。完成后 git commit（只 add 自己改的路径）。
