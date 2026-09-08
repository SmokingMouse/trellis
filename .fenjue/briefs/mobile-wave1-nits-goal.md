目标：修一波 review 遗留 3 条（阶段 2，你是 Claude sonnet 坐席，走 agent-tui runner）。分支 feat/mobile-nits-wave1，基于 main 92c6539。worktree 没有 node_modules，先 `bun install --cwd .`。
原文在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-a4-a087/out/review.md` 的 N-1 / N-2 / N-3 小节，先按原文定位再改：
- N-1：删 8 处已被全局 CSS 兜底覆盖的 `max-md:text-[16px]` 死代码（先用扫描器证明全局规则确实覆盖每一处，再删；删后手机断点下这些输入的实测字号仍 ≥16px）。
- N-2：字号扫描器 `scripts/mobile-verify/mobile-input-font-scan.ts` 的两个盲区——style 变量传入（`const s={fontSize:12}; <input style={s}>`）与 globals.css 末尾追加规则——各加一条廉价断言，并用会被抓到的反例证明断言真的会红。
- N-3：手机视口（390×844）下 `/settings/prefs` 在 select 变 16px 后的布局截图，存到 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/settings-prefs-mobile.png`，在 result.md 里说明有无溢出/错位；有问题就修。
约束：桌面零回归；不改业务逻辑。交付前跑 `bun scripts/mobile-verify/mobile-input-font-scan.ts`、`sh scripts/mobile-verify/mobile-touch-targets.sh`、`sh scripts/mobile-verify/mobile-slim-shell.sh`、`sh scripts/mobile-verify/mobile-safe-area.sh`（最后这条在机器高负载下会在「新树 modal 关闭后」一步卡 daemon busy，属已知环境问题：跑一次，失败就把输出记进 result.md，不要反复重试）；跑完确认 3471–3478 端口与 `/tmp/trellis-mobile-verify.lock` 已释放，交付后不要再跑脚本。提交到本分支。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。
