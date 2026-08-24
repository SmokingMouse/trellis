---
id: 9d53d5dec4a4
commit: d82e4ebc51ad3bef3b2cf9ab709e5b9e1e84e153
branch: main
timestamp: 2026-08-24T11:59:25+08:00
commit_message: "docs(progress): 更新 Current Focus，S120 已部署上线"
files_modified: ["progress/README.md", "progress/archive.md", "progress/failures.md", "progress/sessions.md"]
agent_percentage: 5.3
---

## Prompt

拉取最新版本，更新下

## Summary

拉取完成。

## 本次拉取

`origin/main` 快进 6 个提交（`18675d4..436d48d`），都是 8-21 并行 session 的成果：

- **S114** Token 统计精准化 + 单卡耗时/Token/纯模型 TPS 仪表
- **S113** 模型选择与管理体验重构（即搜即选 + 厂商预设模版 + 可视标签）
- **S112** 树隐藏修复（彻底移出非隐藏区 + 焦点自动切换）
- **S111** 打标/起题模型可配（app_settings kv + 设置页卡片）
- **S110** 发问相似检测 + 会话自动命名（顺带修了 topic_label 8s 超时暗伤，命中率从 10% 解放）

## progress 合并

上次 session 我改的 4 个 progress 文件未提交，与远端撞了车（远端也用了 S110 这个号）。处理方式：

- 我的部署 session 记录改号 **S115** 进 sessions.md（注明 8-19 发生、8-21 补记），远端 S110 按轮转规则移入 archive.md
- 符号链接 HOME 部署坑重新落进 failures.md 已结案（workspace.md 里指向它的指针不断）
- README 指针区更新为 S115–111（1468B，过尺寸闸）

工作树现在只有这 4 个 progress 文件改动未提交，代码本身干净。S114 的 Next 写着「下次 `make deploy` 部署上线」——要现在部的话说一声，老规矩 `HOME=/data00/home/zhangpeng.pada make deploy`。

