你是 gpt-6-astra 调研坐席。只读契约：不改本仓任何文件；所有实验在 mktemp 目录里 clone / 安装 / 跑，网络可用。
目的：回答「agent-tui 能不能直接复用开源社区的 TUI agent 代码，而不是自研渲染层」。候选（许可证已核实）：
- OpenTUI `anomalyco/opentui`（MIT，TS + Zig 原生核心；@opentui/core / react / solid / keymap；opencode 生产在用）
- opencode `anomalyco/opencode`（MIT，TS；客户端/服务端架构，TUI 客户端基于 OpenTUI + Solid）
- pi `earendil-works/pi`（MIT，TS；自带 TUI 库与 coding agent CLI）
- gemini-cli `google-gemini/gemini-cli`（Apache-2.0，TS + React + 上游 Ink）
- 上游 Ink `vadimdemedes/ink`（MIT）
codex（Rust）/ crush（Go，FSL）/ goose（Rust）只作设计参考，不评估复用。

对每个候选回答并给证据：
1. 许可证与再分发约束；原生二进制的打包方式（@opentui/core 在 macOS arm64 + Bun 下 `bun add` 后能否零配置跑；Zig 是否只在开发仓需要）。
2. 渲染模型：是否 cell 缓冲 + 局部重绘（对照 Claude Code 拆解报告 §1：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cc-tui-design-c117/out/cc-tui-design.md` 的 packed cell / damage / blit / 硬件滚动），宽字符与 CJK / IME、鼠标与选区、resize、alt-screen、滚动容器与长列表虚拟化；引用源码位置。
3. 实测基准（同机同脚本）：OpenTUI(react)、Ink、我们现有 agent-tui 自绘渲染器，各渲染 10000 行含 CJK 与 emoji 的历史，再逐 token 流式追加 2000 帧；记录单帧 p50/p95、每帧写终端字节数、CPU 时间、内存。我们渲染器的基准方法见自审报告 `.fenjue/archive/fj-tui-self-audit2-*/out/agent-tui-audit.md`（未归档则在 `.fenjue/tasks/fj-tui-self-audit2-*/out/`，路径前缀同上）。
4. 复用形态与代价：(A) 只复用渲染层（OpenTUI 或 Ink）重写我们的组件；(B) 整体 fork opencode 的 TUI 客户端，把它的 SDK / session / message / part 类型换成我们 agent-server 协议——量化耦合面：TUI 引用了多少 SDK 类型与端点、适配层多大、哪些能力我们协议里没有对应；(C) 复用 pi 的 TUI 库。各给工作量（坐席单数）、风险、能拿到与拿不到的能力。
5. 结论：一个推荐路线 + 两个备选并说明理由；采用 OpenTUI 时必须先验证的 3 个不确定点。

产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/oss-tui-eval.md`（中文，带 file:line / URL / 命令输出摘要）。基准脚本与原始输出也放进 out/。
