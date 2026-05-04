import type { ChatMessage } from "./types";

type Canned = { keywords: string[]; text: string };

const responses: Canned[] = [
  {
    keywords: ["rust", "ownership", "所有权", "汇编"],
    text: `Rust 的 ownership 系统**完全在编译期完成**——runtime 没有任何开销，这是它和 GC 语言最本质的区别。

实际机制：

1. **借用检查（borrow checker）** 在编译期分析所有权流转，违规直接编译失败
2. drop 调用是编译器自动插入的，对应 LLVM IR 里的普通函数调用
3. 所有权转移（move）在汇编层就是 \`memcpy\` 或者直接的寄存器移动

例如：

\`\`\`rust
fn main() {
    let s = String::from("hello");
    take(s);  // 所有权转移到 take
    // 这里 s 不再有效，编译期保证
}
\`\`\`

编译后大致：

\`\`\`
call String::from
call take      ; s 被 move
               ; 这里没有 drop(s)，已经 move 走了
\`\`\`

总结：borrow checker 是 0 cost abstraction 的典范，所有保证都在编译期完成。`,
  },
  {
    keywords: ["drop", "flag", "析构", "时机"],
    text: `好问题。这种情况编译器会引入 **drop flags**——一个隐式的 bool 跟踪变量是否需要 drop。

\`\`\`rust
let x: Vec<i32>;
if cond {
    x = vec![1, 2, 3];
}
// 这里 x 可能没初始化
\`\`\`

编译器生成等价于：

\`\`\`rust
let mut x_dropflag = false;
if cond {
    x = vec![1, 2, 3];
    x_dropflag = true;
}
if x_dropflag { drop(x); }
\`\`\`

不过现代 Rust（2018+ NLL）大多在 MIR 层用 dataflow 分析消掉了这些 flag，只在真正需要时保留——所以"开销"绝大多数时候是 0。`,
  },
  {
    keywords: ["async", "pin", "self-reference", "await", "状态机"],
    text: `async 是一个例外——它需要 **Pin** 来配合。

async fn 编译后会变成一个状态机，状态机内部可能持有指向自己其他字段的引用（局部变量跨 await）。这违反了 Rust 的"移动安全"假设。

\`Pin<P>\` 不是运行时检查，而是**类型系统层的 unsafe 契约**：

- \`Pin<&mut T>\` 承诺这块内存不会再移动
- 这让 self-referential 安全
- 仍然 0 cost——只是 API 复杂度的成本

所以严格说 ownership 仍然全静态，但 async 引入了 Pin 这个新的"维度"来表达"不可移动"。

具体实现层面：每个 await 点编译器都会保存当前状态机的状态。如果跨 await 引用了局部变量，编译器把这些变量"提升"到状态机的字段中，并通过 Pin 来保证状态机本身不被移动。`,
  },
  {
    keywords: ["react", "fiber", "reconciliation", "diff", "虚拟 dom"],
    text: `React 的 reconciliation 是把"用 JSX 描述的 UI"和"DOM 实际状态"对齐的算法。

核心是 **diffing**——React 比较新旧 virtual DOM 树，算出最小的 DOM 变更。

朴素 diff 是 O(n³)，对树太慢。React 用了两个启发式：

1. **不同 type 的元素直接整棵替换**（不深入 diff）
2. **同层的 children 用 \`key\` 配对**（避免 O(n²) 的两两比较）

### Fiber 是什么

老版 React 的 reconciler 是同步递归——一旦开工就停不下来，长列表会卡 16ms 渲染预算。

Fiber（React 16+）把渲染拆成可中断的工作单元：

\`\`\`js
type Fiber = {
  type, props,
  child, sibling, return,  // 树指针
  alternate,               // 双缓冲 - 上次的 fiber
  effectTag,               // 这个节点要做啥（更新/插入/删除）
};
\`\`\`

工作循环用类似 \`requestIdleCallback\` 的机制让出主线程，让高优先级的输入事件能打断低优先级渲染，避免 jank。`,
  },
];

export function pickResponse(
  question: string,
  _history: ChatMessage[],
  parentAnchor?: { selectedText: string } | null,
): string {
  const haystack = (
    question +
    " " +
    (parentAnchor?.selectedText ?? "")
  ).toLowerCase();
  for (const r of responses) {
    if (r.keywords.some((k) => haystack.includes(k.toLowerCase()))) {
      return r.text;
    }
  }
  const ref = parentAnchor?.selectedText
    ? `\n\n（这是从父节点选中的"${parentAnchor.selectedText.slice(0, 40)}${parentAnchor.selectedText.length > 40 ? "…" : ""}"分叉过来的问题）`
    : "";
  return `针对你问的「${question.slice(0, 60)}${question.length > 60 ? "…" : ""}」，这里是一个 mock 回复。

实际接入 LLM 后会是真实的回答。Mock 模式下，输入这些关键词可以触发预设回答：

- **Rust / ownership / 汇编** — 讲 ownership 在汇编层
- **drop / flag / 析构** — 讲 drop flags 和 NLL
- **async / pin / 状态机** — 讲 Pin 与 self-reference
- **React / fiber** — 讲 React reconciliation

\`\`\`typescript
// 选中代码块也能测试分叉
const example = "select me to branch";
\`\`\`

继续选中文字试试 ⌘K 吧。${ref}`;
}
