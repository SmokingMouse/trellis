# 结构面板恢复右下浮窗

契约：`fj-structure-floating-panel-7b4f`；分支：`fix/structure-floating-panel`。

- 桌面 `StructurePanel` 恢复右下 290px 圆角浮窗，最高 45dvh，内容滚动；收起为话题数 / 未读数徽标，沿用展开状态持久化。移除正文、画布、Composer 及按钮对 `--trellis-structure-w` 的占位依赖；旧画布新建按钮在桌面移至顶部，手机位置保留。
- 节点行统一显示已读灰点 / 未读蓝点 / 等待处理橙点，蓝橙与地图一致；当前行增加左 accent 条，话题根加粗并始终显示节点数。桌面行距缩小，手机全屏 sheet 和 44px 触控目标保留。森林、当前链、其它分支、过滤、新话题和地图入口沿用原实现。
- 最终代码 `bunx tsc --noEmit` exit 0；`bun test` 311 pass / 0 fail / 33527 assertions；改动组件定向 ESLint exit 0。11 条手机脚本按契约完整隔离前缀串行独占跑绿，实际退出码见证据目录 `mobile-final-exits.txt`。
- 3503 生产库只读 `.backup` 隔离验证：1440×900「宽」档 `.md-body` 958px，展开 / 收起不变；展开浮窗 x=1138–1428、y=399–804、290×405px，收起徽标 153.30×34px。正文右缘 x=1304，与浮窗交叠 166px，锚点对齐旧版；三键 44×44px、y=844–888，中心命中自身，与浮窗底边相距 40px。390×844 手机 sheet 实测全屏。普通 6 节点、66 节点 / 10 条其它分支、124 节点三档截图及旧新并排对照均已保存。
- 旧断言迁移：`mobile-safe-area.sh` 和 `mobile-followup-approval.sh` 从 push 水平分区改为 Composer 全宽与浮窗纵向避让；`mobile-slim-shell.sh` 恢复强制桌面全宽断言；`mobile-touch-targets.sh` 更新徽标与浮窗注释，保留新话题可达、手机触控和桌面尺寸检查。
- 已结案截图脚本差异：手机菜单包含图标，严格匹配 `textContent === "结构"` 找不到按钮。改用既有 `data-mobile-target="overflow-tree"` 后完整复跑 exit 0；首轮日志保留为 `visual-attempt1.log`。产品代码未因该错误改动。

证据目录：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-structure-floating-panel-7b4f/out/`，`result.md` 汇总逐项命令、截图路径及清理检查。

Next：提交主控独立验收；仅本分支本地提交，不 push、不 PR、不部署。按契约保留 `progress/README.md` 原样。
