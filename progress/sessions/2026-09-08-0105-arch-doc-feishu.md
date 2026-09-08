# S146 · 2026-09-07 23:40 – 2026-09-08 01:05 · 《Trellis 当前架构介绍》writecraft 成稿并落飞书

## 起因

用户：「让 gemini 写一篇现在的架构介绍？」→「使用 write-craft 写，写到飞书云文档里」→ 对 Design Brief 回「按这个来吧」→ 对预览卡回「y」。

## 管线（全部坐席执行，leader 只对齐、派单、独立核验）

1. **事实稿**（Gemini 3.8 flash，arch-doc）：真源盘点，334 行、七大节，作素材。
2. **Design Brief + 2B 骨架**（leader 按 write-tech-design 与用户对齐）：`.fenjue/briefs/arch-doc-brief.md`——信息传输型、跨系统架构为主、飞书工程文档形态、图三张、每断言附相对路径出处、强制标「main 已上线 / 分支在途」。
3. **成稿**（Gemini，doc-write，15 分钟）：article.md 5521 CJK、overview.svg、plan/verify/sources。
4. **审阅一**（Opus，doc-review）：需改稿——6 P0（影子模式状态过期、引用不存在的组件、脚本数与端口错、单测数字错配、409 守卫标错上线状态）、10 P1、7 P2。
5. **改稿**（Gemini 复用，doc-fix）：48 条改动带原文对照，4792 CJK，SVG 重画。
6. **审阅二**（Opus 复用，doc-review2）：可交付；27 条复跑全过；剩 4 P1 + 5 P2 非阻塞。
7. **收尾**（Gemini 复用，doc-fix2）：9 条全修，4856 CJK；SVG 连线全部走框外（leader 渲图核过）。
8. **飞书转换**（Sonnet，doc-feishu-prep → doc-feishu-final）：md2lark.ts 产 payload.xml（94 顶层块：8 h1 / 24 h2 / 10 表 / 2 画板），`docs +create --dry-run` 请求体与载荷逐字节一致。
9. **建文档**（leader 亲自跑，用户对预览卡回 y 后）：
   - `lark-cli docs +create --as bot --content @payload.xml --parent-position my_library`
   - 文档：**https://bytedance.larkoffice.com/docx/DA4idGObAo1h7Bxb7lEcTvaEnNf**（document_id DA4idGObAo1h7Bxb7lEcTvaEnNf）
   - 授权：bot 自动给 CLI 当前用户 full_access；另 `drive +member-add` 给 ou_32b5…6325 full_access（成功）。
   - 画板：SVG 总览 Ty7cwJVGghPkhfbifFRc6rpNnBd 渲染完整；Mermaid 时序 FGsSwLSgqhHQ8Bbzvp8cVRMwn3g 首次渲染把转换器补的双引号原样画进图 → 用成稿原始 Mermaid `whiteboard +update --input_format mermaid --overwrite` 覆盖，导出 SVG 本地渲图核过无引号。

## 实弹经验

- 飞书 Mermaid **时序图**消息文本不要加双引号：安全子集里「标签含括号加引号」只适用于 flowchart 节点，时序图会把引号渲进图。md2lark.ts 的 `quoteMermaidLabels` 需按图类型分支（未改，脚本在 `.fenjue/archive/fj-doc-feishu-final-aea6/out/`）。
- `whiteboard +update` 必须带 `--input_format mermaid --overwrite`，否则按 raw JSON 解析报 unmarshal 错。
- `whiteboard +query --output_as image` 的缩略图在 update 后不会即时重生成（几分钟内仍是占位图）；要核渲染用 `--output_as svg` 取 `data.svg_content` 本地 rsvg-convert。
- `--output` 只接受相对当前目录的路径。
- lark-cli user 身份过期时 `docs +create --as bot` 可用，返回 `permission_grant` 自动给 CLI 当前用户 full_access；额外协作者用 `drive +member-add --type docx --member-type openid --perm full_access --yes`。
- writecraft 管线里 Gemini 写手 + Opus 审阅的组合有效：两轮审阅抓出 6 条事实性 P0，全部是 Gemini 从过期素材照抄或行号错引，异源审阅不能省。

## Next

- 用户读飞书文档后的纠偏按 writecraft §3a 沉淀（偏好类进 write-tech-design/references/feishu-engineering-doc.md 经验层）。
- md2lark.ts 的时序图引号规则待修（下次导入前）。
- 其余三条线仍等用户决定（见 S145 Next）。
