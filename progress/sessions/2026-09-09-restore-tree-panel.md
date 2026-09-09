# 原组件恢复树面板

契约：`fj-restore-tree-panel-ccd2`；分支：`fix/restore-tree-panel`。

- 恢复 013adb9 的 TreePanel 挂载、Outline 挂载、标题栏与手机菜单入口；TreePanel、Outline、直接依赖和全局样式与基准零差异，无组件适配。删除 StructurePanel、structure-panel 工具与测试、相关 flag。侧栏与 Header 对基准零差异，README 按契约不改。
- 保留波 4 返工地图，以 page portal 独立挂载；原线性标题栏「🗺 画布」与手机菜单「画布」打开地图，选点落回线性并高亮。地图不再依赖结构面板工具，原布局排序和几何不变。
- 3504 生产库快照与 013adb9 隔离重建实测：桌面默认态、选中态及手机的完整面板 outerHTML、DOM rect、状态点全等。指定旧截图面板 (1138,349,290,455) 的 131950 个像素全部一致；节点行高 22px，每层缩进 10px；手机 sheet (0,0,390,844)。附 124 节点、6 节点、手机与地图截图。
- `bunx tsc --noEmit` exit 0；`bun test` 301 pass / 0 fail；11 条手机脚本统一隔离前缀串行独占 exit 0。结构断言恢复为原树面板，地图断言改从旧画布入口进入。3471–3480、3504 无监听，验证锁已清。

证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-restore-tree-panel-ccd2/out/result.md`；`compare.html` 为并排截图，`compare-dom.py` 可重验完整 DOM 和旧截图面板像素。

Next：主控独立验收；只提交本分支，不 push、不 PR、不部署。
