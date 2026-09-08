# 侧栏波 4：画布地图化

契约：`fj-sidebar-wave4-7058`；分支：`feat/sidebar-wave4`。

- 地图唯一入口位于结构面板底部；桌面 modal、手机 sheet 地图页。每次进入在节点测量后 fitView，快照当前节点并标蓝框；选择节点关闭地图及手机结构 sheet，回正文定位、高亮 2.2 秒。阅读区、Composer、审批实现保持原动线。
- 独立地图布局按话题排列全部节点，保留父子连线，忽略阅读折叠状态。概览只渲染话题色块、标签与未读/等待点；悬停或聚焦只显示一张详情卡。没有新增 LOD、聚类或 minimap，也不挂 Outline。
- 构建时 `NEXT_PUBLIC_TRELLIS_CANVAS_MAP=off`（或 `0`）恢复旧画布一个版本；默认开启。开启时 `viewMode` 只使用 linear，地图开闭不持久化；旧 localStorage canvas 值迁移为 linear，保留 node/offset；URL 的 view/viewMode/mode=canvas 或 linear 删除，保留 session/node 及其它参数。
- 生产库 `.backup` + 隔离 HOME/DB + `next start -p 3501`：最大会话 124 节点 / 10 话题，两端 inView 都为 124/124（旧体检 6/124）；1440×900 缩放 1、标签 12px；390×844 缩放 0.921446、标签 10.14px。小会话 19/19。八张截图覆盖全貌、详情、定位、手机、回退。
- 最终 `bunx tsc --noEmit` exit 0；`bun test` 302 pass / 0 fail、31975 assertions。全部 11 条手机脚本按契约环境前缀独占串行 exit 0；D3 最终另跑 exit 0；D4 exit 0（3471–3480 / 3501 无监听、锁清）。新组件/布局/测试 ESLint exit 0。flag off 构建与浏览器回退通过，已恢复默认构建。
- 两处已解决的浏览器验证问题：受控 React Flow 未回写测量导致 fitView 队列挂起，接入 useNodesState/onNodesChange 后通过；关闭图层拖拽/选择导致节点 pointer-events:none，显式恢复按钮指针事件后悬停/点击通过。可重复证据脚本在产物目录。
- 手机断言迁移：branch-chain 的旧 overflow/Header 画布跳转改为结构→地图→节点，验证 linear 持久化、sheet 关闭、落点高亮及 H-3；slim-shell 删除 overflow 画布枚举，地图入口改为结构内，按 data-map-node 检查七个业务节点全可见，关闭地图后回结构 sheet。其它九条脚本未修改。

证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave4-7058/out/result.md`。

Next：主控独立验收；仅本地提交，不 push、不 PR、不部署。
