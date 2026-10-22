# 2026-10-22 Herdr 终端色彩层级与表格排版上线

## 做了什么
- 终端色彩重构：正文由暗灰 text-ink-muted 提升为高对比 text-ink (#e8e8eb)，画布采用深邃微蓝黑 #0a0b10 消除死黑眩光；底部操作栏按键与模型芯片全部收敛为深色胶囊
- 消除反白与 TUI 残留：bypass permissions 刺眼白条转为暗色状态胶囊，过滤 Jump to bottom 屏幕滚动提示
- ASCII 表格排版保护：连续表格行独立打包横向滚动，边框与数据分离着色并加粗表头；上线 e2775c0 并完成 prod 部署

- 深度对齐 herdrx 架构引入 xterm.js 真实终端：接入 @xterm/xterm 与 @xterm/addon-fit，后端开放 format: ansi 24-bit TrueColor 转义流，默认以字符网格仿真呈现；上线 2246a0d 并完成部署

## 决定
- [decision] 终端正文不降权：除元信息与时间戳外正文保持主色高对比度，视觉焦点不给底部操作区
- [decision] 终端仿真对齐 herdrx：默认采用 xterm.js 字符网格仿真，保留「重排」与「原始」多模切换
- [decision] 终端组件恒暗隔离：强制 dark 作用域与物理级 #e4e6ee 前景，不受外层浅色主题变量污染
- [decision] 表格行拒绝 break-all：保留单行字符矩阵对齐，允许局部横向滚动

## Next
观察生产环境下各类 Agent（Claude/Codex）复杂 TUI 输出与深色表格的可读性表现。
