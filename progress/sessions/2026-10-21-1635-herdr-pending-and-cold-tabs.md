### 做了什么
1. 修复主页 Herdr 待回复错位：在 HomeView 中将 waiting/blocked 窗格移入顶层「等你处理」区块，渲染提问/审批卡片，支持行内快捷回复（回车直发队列）与打开终端抽屉。
2. 修复冷 Tab 排序退化为创建时间：在 herdr-fleet 服务端注入 transcript.mtime，建立 hook -> mtime -> lastSeenAt -> firstSeenAt 级联兜底链，修复 PickerSheet 比较逻辑。

### 决定
- [decision] Herdr 待回复统一并入首页「等你处理」而非另起独立区块；拒绝理由：保持工作台入口层极简，避免出现多个同质通知区块。
- [decision] 冷 Tab 活跃时间优先读 transcript 文件 mtime；拒绝理由：终端纯敲命令不一定触发 hook，文件 mtime 才是终端真正的最后交互时间。

### Next
观察主页挂起提问就地回复的真实流转情况，推进多工作区切换体验。
