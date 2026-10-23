import { createContext } from "react";

// 正在流式输出的 markdown 子树为 true（TurnCard 的 live 分支包一层）。
// 代码块据此区分「模型还在写」和「已经写完」：前者源码每帧都在变，图表要等
// 内容静止再渲染、半截源码解析失败也不当错误展示。
export const MarkdownStreamingContext = createContext(false);
