# qr-ui · 扫码建 / 更新飞书 bot：设置页

## 目标
- `/settings/bots` 顶部加一个主按钮「扫码创建机器人」，分三步：填信息 → 扫码或点链接确认 → 已连接。
- 已有 bot 的每一行加「补权限 / 更新配置」按钮；这个 bot 有 missingScopes 时按钮高亮，并列出缺哪些 scope。
- 旧的手动填 App ID / Secret 表单保留，但折叠起来，标题改成「手动接入已有应用」。

## 契约
已在 main 定好（`lib/lark-types.ts` 末尾，commit 7c57fe5），不要改。

| 接口 | 请求 | 响应 |
|---|---|---|
| `POST /api/lark-bots/register` | `LarkRegisterRequest` | `LarkRegisterStart {sessionId, url, expiresAt}` |
| `GET /api/lark-bots/register/:sessionId` | — | `LarkRegisterSession`，每 2s 轮询一次，直到终态 |
| `DELETE /api/lark-bots/register/:sessionId` | — | 取消；关弹窗或点取消时调用 |
| `GET /api/lark-bots` | — | 列表项新增可选字段 `missingScopes?: string[]` |

服务端由另一个坐席并行实现，你这边只按契约写。接口没好之前用本地 mock 自测，不要自己实现服务端。

## 交付物

### 1. 新组件 `app/settings/bots/RegisterBotModal.tsx`
放在 `app/settings/bots/` 下合适的位置，基于 `components/ui/Modal.tsx:13`。

**第 1 步：填信息（create 模式）**
- 名称，默认「Trellis 助手」
- 描述，可选
- Agent：复用页面现有的 agent 列表和就地新建逻辑（page.tsx:744-868）
- 工作目录
- 访问模式：默认「需要我审批」，配一句说明

**第 2 步：扫码确认**
- 二维码：新增依赖 `qrcode` 和 `@types/qrcode`（用 `bun add`），在客户端渲染成 SVG。
- 「在浏览器打开确认页」链接。
- 按 expiresAt 倒计时。
- 状态文案：「等待你在飞书确认」→「已确认，正在连接…」。
- 说明文案：「用飞书手机端扫码，或在已登录飞书的浏览器打开链接；确认页会列出机器人需要的权限」。

**第 3 步：完成（done）**
- 标题：✅「{name}」已创建并连上。
- 按会话的 `connected` / `adminBound` / `welcomeSent` 逐项打勾：已连接、你已是管理员、已给你发了一条私聊。哪项没成就如实显示。
- 下一步提示：把它拉进群，然后 @ 它。

**失败终态**

| 状态 | 显示 | 操作 |
|---|---|---|
| denied | 你在飞书取消了 | — |
| expired | 二维码过期 | 一键重新生成 |
| error | error 原文 | 重试 |

**update 模式**
- 跳过第 1 步，标题用「补权限 / 更新配置」。
- 完成文案：「配置已更新并重连」。

### 2. 改 `page.tsx`（1262 行的单文件）
- 顶部加主按钮。
- bot 行加「补权限」按钮和 missingScopes 提示。
- 旧的手动表单折叠。
- 完成后刷新列表（复用 page.tsx:139-147 的拉取逻辑）。

### 3. 适配手机宽度
小屏上以链接为主，二维码为辅。

## 约束
- 动手前先读 `node_modules/next/dist/docs/` 里 client component / app router 相关的文档（仓库 AGENTS.md 的要求）。
- 只改这些文件：
  - `app/settings/bots/**`
  - `package.json`、`bun.lock`
  - 必要时对 `components/ui` 做小扩展
- 不改 `lib/server/**`、`app/api/**`、`lib/lark-types.ts`。
- 视觉跟现有设置页保持一致：Tailwind，沿用现有组件风格。除 qrcode 外不引入新的 UI 库。

## 验收
- `bun x tsc --noEmit` 通过。
- `bun test` 失败数 ≤ 5（main 基线已有 5 个存量红）。
- `bun run build` 通过。
- 汇报附文字说明：create 三步、update 模式、三种失败态分别长什么样（用 mock 数据即可）。
