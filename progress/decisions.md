# Decisions Log

轻量方向性决策追加日志（重量级走 `decisions/` ADR）。开新方向前查此处；冲突时 reference 对应条目。

---

## 2026-06-16 · CLI 分支对齐 P2 简化：trellis 发起的分叉统一构造前缀 jsonl

**Decision**：P2 不再分 tip→`--fork-session` / 非 tip→前缀 jsonl 两路；所有 trellis 发起的
attached 分叉都走「复制 root→X、复用 uuid、改 sessionId、写 `<newSid>.jsonl`、再 resume」。
**Why**：一条机制覆盖任意分叉点，`newSid` 由 trellis 同步生成，不需要从 `session_init` 异步捕获；
代价是放弃 fork-session 的 KV cache 复用，首轮稍慢但可接受。
**Alternatives**：沿用母设计 tip `--fork-session` 路径 —— 拒绝，多一条异步身份路径，且只覆盖 tip。
**取代**：上条 CLI 分支对齐母设计中的「trellis tip 分叉→`--fork-session`」映射；其余 union-by-uuid
和前缀 jsonl 支点不变。

## 2026-06-16 · CLI ↔ trellis 分支对齐（设计完成，待实现）→ [cli-branch-alignment.md](cli-branch-alignment.md)

**Decision**：让 CLI 的 rewind/branch 与 trellis 分叉双向对齐。统一模型 = **一棵 trellis 树 =
一组 CLI session（root + forks）按 jsonl message uuid 求并集**。
**关键实测支点**：① fork-session 复制祖先 uuid 不变 → union-by-uuid 自动合并零重复；②
`claude --resume` 对 in-jsonl 多叶子只走主链 → in-jsonl fork 不可靠 resume，可 resume 的分支必须是
独立 session（fork-session）；③ 从任意历史节点分叉用「构造前缀 jsonl（复制 root→X、复用 uuid、改
sessionId）+ resume」实现，已验证（绕过 `--fork-session` 只能从 tip 分的限制，也绕过 SDK 无 fork
父点选项）。
**映射**：CLI rewind/edit→trellis 兄弟节点（解析器已支持）；CLI /branch→新 fork jsonl→union 成
子树；trellis tip 分叉→`--fork-session`；trellis 任意节点分叉→构造前缀 jsonl。
**范围**：只动 `origin='cli-import'` attached 会话（project 模式那一支），原生 chat/workspace/
project 零改动，chat B-fork 机制复用不改。
**Alternatives**：① in-jsonl fork 写一个 jsonl —— 拒绝（resume 看不到非主链分支，实测证伪）。
② SDK 指定 fork 父点 —— 拒绝（RunOptions 只有 resume+forkSession，无此选项）。
**状态**：未实现，下一个 session 从 P1（union 导入）起。

## 2026-06-16 · 【推翻】CLI 同步改为 per-session attach + 真双向（取代下方"只读镜像"决策）

**Decision**：用户反馈推翻"按目录批量只读镜像"。改为：① **per-session attach**——用户浏览
本机 CLI 会话清单、**手选**哪些 attach（不按目录批量灌）；② **真双向**——attach 后两侧都能
续聊，trellis 续聊走 project-mode `resume` 写回同一 jsonl，CLI 侧续聊由 watcher 导回。
**Why**：用户要"自己选 + 两侧同步"。recon 发现 project 模式本就 `resume + persistence`，双向
续聊底层现成；importer 已用 jsonl uuid 当节点 id，单一命名空间现成。
**关键解法（身份对账）**：SDK 流不暴露 turn 的 jsonl uuid，trellis 自建节点会和 watcher 导入
撞双份。解法 = **jsonl 为唯一真相源**：trellis 续聊完（Result 后）删临时流式节点 + 重导 jsonl，
让该轮以 canonical jsonl-uuid 节点落地，两方向收敛到 import 一条路。
**物理约束**：同一会话不能 CLI + trellis 同时各聊一轮（抢 append）；串行无碍。
**对 claude_session_id 的修正**：attach session 需设 `claude_session_id`（resume 必需），删除
hazard 由已加的 `origin='cli-import'` 闸挡（detach/删 trellis 侧不动原始 jsonl）。
**Alternatives**：① 维持只读镜像 → 用户明确否决。② 给 trellis 节点读 jsonl tail 取 uuid 后
re-key（不删建）→ 比"删临时+重导"更碎（要改 children/FTS/notes/root_node_id），且新建无 children
的 leaf 删了零风险，故选删+重导。
**取代**：下方 2026-06-16"只读镜像"决策作废，仅留作演化轨迹。

## 2026-06-16 · CLI Session 同步 = 只读镜像，不续聊（v1）【已被上条推翻】

**Decision**：本机 CLI 会话同步进 trellis 做成**只读镜像**——浏览/搜索/导出，v1 不在镜像
session 里续聊。
**Why**：续聊会和 CLI 进程抢写同一个 `<sid>.jsonl` → 写冲突 + 状态撕裂。只读镜像零冲突。
**Alternatives**：① 直接续聊同一 jsonl —— 拒绝，抢写。② 续聊走 `--fork-session` 复制一份
再聊 —— 是对的方向，但属增量功能，拆成独立 Stage D，不进 v1。
详见 [cli-sync.md](cli-sync.md)。

## 2026-06-16 · 防回环去重 = 按 session id 排除 trellis 自有 jsonl

**Decision**：同步时跳过「文件名（去 `.jsonl`）∈ trellis 自己 spawn 的 session id 集合」的
jsonl 文件。集合来自 `nodes.claude_session_id` / `codex_session_id`。
**Why**：trellis 自己 spawn claude 也往 `~/.claude/projects/` 写 jsonl；不排除会把 trellis
自有会话再导回来 → 重复 + 回环。jsonl 文件名恰好就是 session id，排除键天然现成、可靠。
**Alternatives**：① 在 jsonl 内容里嗅探 trellis 特征 —— 脆、无稳定标记。② 让 trellis spawn
时写到隔离目录 —— 改动大且破坏 CLI 兼容。

## 2026-06-16 · 同步范围 = opt-in 选择器，非全量

**Decision**：用户勾选要镜像哪几个 project 目录/会话，只 watch 这些。
**Why**：本机 88 个 project 目录，全量镜像会把 SessionPicker / SessionTabs 瞬间淹没。
**Alternatives**：全量自动镜像 —— 拒绝，列表噪音不可接受。
