# cards-watch：巡检脚本输出飞书卡片 JSON

工作目录：/data00/home/zhangpeng.pada/.claude/skills/sub2api-admin

## 背景
`scripts/alert_watch.py` 现在输出 markdown（或 `[SILENT]`），trellis 把 stdout 原样当最终答复推到飞书群。卡片版式已由 leader 用 lark-card 技能设计好，渲染函数在 `scripts/alert_cards.py`（**leader 维护，你只 import 调用，不要修改它**）：
- `build_alert_card(events, pool, subtitle, admin_name) -> dict`
- `build_daily_card(pool, kpi, pending, refill, earliest_card, valid_cards, subtitle) -> dict`
参数形状见 alert_cards.py 各函数 docstring；`/tmp/card_preview.py` 是 leader 写的一次性预览脚本，演示了如何从 `fetch_all_data` 的数据构造这些参数（注意：`fetch_all_data` 返回的已是处理后的数据，**不要再调 process_raw_data**）。

## 要做
1. `evaluate_alerts(...)` 新增可选参数 `events: Optional[list] = None`：非 None 时，每产生一条要发的告警 / 恢复，就同时 append 一个结构化事件：
   `{kind: auth_lost|card_urgent|card_soon|pool_503|recovered, account, owner_name, owner_open_id, detail}`（pool_503 的 account=None、owner 是管理员）。detail 用简短中文：授权掉了用「Token 已失效，已停止调度」或「账号报错：<brief_error>」；卡临期「<剩余时间> 过期」；503「今日新增 N 次「No available accounts」，今日累计 M 次」；恢复「授权已恢复」。文本行输出与去重逻辑**一字不改**（现有 13 个测试必须全绿）。
2. 新增 `--format {markdown,card}`（默认 markdown，保持兼容）：card 模式下有要发的内容 → stdout 输出 `json.dumps(build_alert_card(...), ensure_ascii=False)` 一行；没有 → 仍输出 `[SILENT]`；取数失败的提示保持纯文本（不走卡片）。subtitle 形如「驾车导航分组 · 09-24 17:30」（北京时间），admin_name 取 owners 里管理员中文名。
3. 新增 `--daily-card`：取 `fetch_all_data(period="yesterday")`（账号是当前状态、kpi 是昨日），构造 pool / pending（当前全部可行动项，不去重、**不 @**：owner_open_id 置空）/ refill（7 天额度用满且未掉授权、有有效卡的号）/ earliest_card / valid_cards，输出 `build_daily_card(...)` 的 JSON；不写 state；同时支持 `--snapshot-dir` 刷新快照。subtitle 形如「驾车导航分组 · 09-25 周四」。
4. pool 统计口径与快照一致：授权掉了（is_auth_lost）→ lost；否则 7 天用量 ≥100 → exhausted；其余 available。
5. 更新 `references/alert-watch.md`：新增两个参数的用法与 trellis 任务 prompt 示例。

## 约束
- 只改 scripts/alert_watch.py、scripts/test_alert_watch.py、references/alert-watch.md；不改 alert_cards.py / report.py / 其他文件；**不要 git commit**；不向飞书发任何消息（真实库只读冒烟可以跑，但不 --send）。
- 测试（unittest，只用标准库）新增：card 模式输出可 json.loads 且 schema=="2.0"、含 <at id=…>（有 open_id 时）；无事件仍 [SILENT]；--daily-card 在 fixture 上输出合法卡片且不含 <at；events 参数不影响原文本输出。
