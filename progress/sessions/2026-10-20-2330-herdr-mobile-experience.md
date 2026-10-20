# 2026-10-20 Herdr 移动端体验优化上线

## 做了什么
- 新增 Tab 创建 API 与 command 通信接口，解除 shell 窗格输入限制；移动端 Header 增加态势胶囊与快速建 Tab
- 终端工作台全面对齐 herdrx 架构：上线 HerdrMobileWorkbench 全屏打平单 Pane 视图与双模切换，1000 行平滑无限上滑
- 根治行文过长溢出：全量应用 break-all 与 [overflow-wrap:anywhere]，提升至 z-50 解决层级与背景穿透；上线 951e757

## 决定
- [decision] 移动端终端交互全面对齐 herdrx 范式：放弃半截抽屉遮罩，直接打平成全屏单 Pane 工作台；顶栏保留 [对话/终端] 一键无缝切回
- [decision] 解决背景无区分与长行溢出硬伤：全层级强制 break-all 折行，提升至顶级 z-50 杜绝背景透视

## Next
在手机端深度使用 herdrx 式打平终端工作台，观察长路径与连续输出折行表现。
