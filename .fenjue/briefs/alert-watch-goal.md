# alert-watch：sub2api 号池巡检脚本（确定性判定 + 去重 + @ 号主）

工作目录：`/data00/home/zhangpeng.pada/.claude/skills/sub2api-admin`（sub2api-admin 技能目录）

## 背景

trellis 的定时任务每 30 分钟让一个只读 agent 跑一次本脚本。流程如下：

- 脚本的 stdout 原样作为 agent 的最终答复。
- trellis 把这段答复推到飞书群。卡片里的 markdown 会把 `<at id=…></at>` 渲染成真正的 @。
- 最终答复是 `[SILENT]` 时，trellis 不推送。

@ 谁、什么时候 @、要不要重复提醒，**全部由脚本判定，不交给 LLM**。

数据来源是同目录的 `scripts/report.py`（隔壁 session 新写的，尚未提交）。只 import 调用其中两个函数：`fetch_all_data(period, group_id, group_name)` 和 `process_raw_data(data)`。**不改 report.py、bot_notify.py，也不改任何其他已有文件。**

先读一遍 `report.py` 的 `process_raw_data` 返回结构，确认字段名和取值。关心的字段：

- accounts 的 `status` / `schedulable` / `deleted_at` / `error_message` / `token_status` / `cards_list`
- `errors`：503 计数

## 规则

规则依据 2026-09-24 的实测数据制定，理由要写进 docstring。

| 类别 | 判定 | 通知 |
|---|---|---|
| AUTH_LOST（授权掉了） | 账号未删除，且满足任一条：`status=='error'`；`token_status=='EXPIRED'` 且 `schedulable` 为假；`error_message` 命中 401 / invalidated / revoked / permanently rejected | @ 号主。首次立即发，未恢复则每 24h 再提醒一次。恢复（不再命中）时发一条「✅ 已恢复」，并清除该项状态 |
| CARD_EXPIRING（重置卡临期） | 该账号的有效卡里，最早一张 ≤7 天到期。≤3 天为 URGENT，否则为 SOON | @ 号主。SOON 只提醒一次；升级到 URGENT 时再提醒，之后 URGENT 每 24h 提醒一次。卡消失（用掉或过期）时清除状态，不发恢复消息 |
| POOL_503 | 今日 503（No available accounts）的累计次数比上次巡检记录的多。跨天后从零重算 | @ 管理员（`--admin`，默认 zhangpeng.pada），附本次新增次数 |
| 不报 | TOKEN_EXPIRING：网关的 token_refresh 会自动续期。ACCOUNT_SUB_EXPIRED / EXPIRING：字段不可靠，qingjiajun 显示已过期 6 天，却仍是今天的主力号。502 / 500：只进日报 | — |

## 接口

```
python3 scripts/alert_watch.py [--state PATH] [--owners PATH] [--admin LDAP] [--group-id 1] [--dry-run] [--list] [--fixture JSON] [--now ISO]
```

**默认路径**

- state：`~/sub2api/.alert-state.json`
- owners：`~/sub2api/owners.json`，格式 `{ldap: {"open_id": "...", "name": "中文名"}}`

owners 文件缺失、或文件里没有这个人时，退化为纯文本 `@中文名(ldap)`，不报错。

**常规模式**

- 有要发的内容时：stdout 输出 markdown，并更新 state。
  - 首行是标题。
  - 之后每条一行，依次是：级别 emoji、账号、@号主、说明、处置指引。
  - 处置指引：授权掉了写「请联系 <@管理员> 获取重新授权链接」；重置卡写「请尽快在该账号上使用重置卡」。
- 没有要发的内容时：stdout 只输出 `[SILENT]`。

**其他模式**

- `--list`：输出当前全部命中项，不去重、不写 state，供日报使用。没有命中时输出「✅ 当前无需处理的事项」。
- `--dry-run`：照常计算和输出，但不写 state。
- `--fixture`：直接读 process_raw_data 形状的 JSON，跳过取数，测试用。
- `--now`：覆盖当前时间。

**取数失败（ssh / DB）**

- 输出「⚠️ 号池巡检失败：<一行原因>」。
- 同一类失败 6h 内只报一次，其余时候输出 `[SILENT]`。
- state 里记录连续失败次数。恢复后，下次正常输出时附一句「巡检已恢复」。

**健壮性**

- 退出码：上面所有情况都返回 0；只有参数错误或程序 bug 才返回非 0。
- state 原子写入：先写临时文件，再 rename。
- state 损坏时，先备份，再重建，不崩溃。

## 交付物（只新增这三个文件）

- `scripts/alert_watch.py`
- `scripts/test_alert_watch.py`：用 unittest，只用标准库。覆盖以下场景：
  - 新问题通知
  - 24h 内去重，输出 `[SILENT]`
  - 超过 24h 再次提醒
  - 恢复消息
  - SOON 升级为 URGENT
  - 503 增量，以及跨天归零
  - 失败去重与恢复
  - owners 缺失时的退化
  - state 损坏后的恢复
- `references/alert-watch.md`：规则表、用法，以及与 trellis 定时任务的接法。任务 prompt 示例：「运行 … 把 stdout 原样作为最终答复，不做任何其他事」。

## 约束

- 只用 Python 标准库，与目录里的现有脚本一致。
- 不改其他已有文件：这个目录里有其他 session 未提交的改动。
- **不要 git commit**，由 leader 统一处理。
- 真实库只读冒烟：跑通 `python3 scripts/alert_watch.py --dry-run --state /tmp/aw-smoke.json`，在 result 里贴输出摘要。这条命令会 ssh 到 GPUDevBox 查库，只读。
- 不向飞书发任何消息。
