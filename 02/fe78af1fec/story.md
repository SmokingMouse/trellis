---
id: 02fe78af1fec
commit: f5b3440a009474523082b6c8247d337e6499b77c
branch: feat/lark-post-rich-text
timestamp: 2026-09-15T21:55:28+08:00
commit_message: "wip(lark): post 富文本收发——升级前存档"
files_modified: ["lib/server/lark/protocol.ts", "lib/server/lark/sdk.ts", "scripts/test-lark-bot.ts"]
agent_percentage: 92.0
---

## Prompt

为啥 agent 的聊天，每次第一条必出现 暂只支持文本

## Summary

修改完成。现在实现了完整的富文本支持：

## 修改总结

### 接收端（`protocol.ts`）—— 解析 post 富文本为 markdown

新增 `extractPostMarkdown`，将飞书 post 消息的各种元素转换成 markdown：

| post 元素 | 转换结果 |
|---|---|
| `text` | 原样文本 |
| `md` | 原样保留 markdown（飞书 post 原生支持 md 标签） |
| `at` | `@用户名`（供 `stripBotMention` 剥离 bot @） |
| `a` | `[text](href)` |
| `img` | `![image](image_key)` |
| `code_block` | ``` ```lang\ncode\n``` ``` |
| `hr` | `---` |

`parseIncomingEvent` 现在对 `text` 和 `post` 都走文本通道，其余类型才提示"暂只支持文本"。

### 发送端（`sdk.ts`）—— 用 post 格式渲染 markdown

新增 `markdownToLarkPost`，把 markdown 包装成 `{ zh_cn: { content: [[{ tag: "md", text }]] } }` 格式。`sendLarkText` 改用 `msg_type: "post"` 发送，飞书客户端会渲染加粗、链接、代码块等格式。

post 的 `md` 标签单元素长度上限 30000 字符（原 text 是 4000），所以截断阈值也相应提高。

### 验证

- 22 个 lark 断言全部通过
- tsc 类型检查无错误
- 测试覆盖了群聊 @bot 的 post 消息：`@中转站接入 给 @陈一民 分配个账号+key` → 提取为 `给 @陈一民 分配个账号+key`（bot @ 被剥离，其他 @ 保留）

