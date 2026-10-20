# 2026-10-20 Herdr 移动端体验优化上线

## 做了什么
- 新增 POST /api/herdr/tabs 服务端接口，支持从移动端新建 Tab（指定 workspace / cwd / label 并自动聚焦）
- 移动端 Header 增加 Herdr 态势胶囊与快速建 Tab 按钮，点击呼出 FleetPickerSheet，冷热分流展示（🔥 活跃并行 vs ❄️ 闲置）
- 升级 HerdrTerminalDrawer 终端抽屉：支持半屏/全屏伸缩切换，增加常用命令快捷芯片（llm claude 等）与 Tab 补全键；停用横向误触滑切；原子上线 2f63220

## 决定
- [decision] 移动端以 Trellis 原生 LinearThreadView 阅读体验为主体，终端以伴侣抽屉形式按需呼出；拒绝纯 CLI 化带来的字符矩阵与缩放拖拽硬伤
- [decision] 窗格切换收敛为显式态势胶囊手动选择；停用屏幕横向滑动手势，彻底消除与代码块横滑及 iOS 边缘返回的冲突

## Next
在手机端真实使用一周，观察新 Tab 创建频率与终端抽屉使用粘性，按需增加一键派发模板。
