// attach 一个 CLI transcript 可能失败的**种类**（纯类型/错误定义，无 IO、无 DB）。
//
// 存在的理由是一次 prod 事故：Herdr fleet 每次 snapshot / pane 事件都会把同一批
// transcript 重新 attach 一遍，attach 失败就把去重 key 删掉、下一轮再来。对「合法
// 但还没有任何对话轮次的空会话」而言这个失败是**确定性**的 —— 同样的字节重跑一万次
// 还是同样的失败，于是 20–30s 一轮无限重试，把主线程拖到 100% CPU（每轮还要把整个
// projects 目录的 jsonl 全解析一遍）。
//
// 所以调用方必须能分清两类失败，且判据是**错误类型**、不是 message 字符串匹配：
//   - 可重试：文件读不到 / 被截断（CLI 正写到一半）/ 临时 IO 错误 → CliTranscriptUnreadableError
//   - 确定性：重跑不会变好 → isDeterministicAttachFailure() 为 true，调用方应停止重试
export class CliTranscriptUnreadableError extends Error {
  constructor(readonly transcriptPath: string, options?: { cause?: unknown }) {
    super(`CLI jsonl is unreadable or malformed: ${transcriptPath}`, options);
    this.name = "CliTranscriptUnreadableError";
  }
}

/**
 * 选中的 jsonl 在 lineage 发现阶段解析不出任何轮次（cli-lineage.ts）。
 *
 * prod 事故（根因 C）：这里原本抛的是**裸 Error**，herdr-fleet 的分类闸认不出来，
 * 于是每轮 snapshot 都重排一次 attach，一条 197MB 的 codex rollout 把
 * /api/providers 拖到 7–16s。触发它的是符号链接 $HOME 让路径比较失配 —— 那个
 * 已经在 canonical-path 那层收口了，但「选中文件解析为空」还有别的走法
 * （文件在发现窗口内被换掉、被别的进程截断重写…），一律是确定性的：
 * 同样的字节重跑不会变好，文件指纹变了 herdr-fleet 自会再试一次。
 */
export class CliTranscriptNoTurnsError extends Error {
  constructor(readonly transcriptPath: string) {
    super(`selected CLI jsonl has no parseable turns: ${transcriptPath}`);
    this.name = "CliTranscriptNoTurnsError";
  }
}

/** trellis 自己的 native session 撞了同一个 id —— 换多少次时机都还是撞。 */
export class NativeSessionConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`session id ${sessionId} already exists as native session`);
    this.name = "NativeSessionConflictError";
  }
}

/** true = 重试不会有任何不同的结果，调用方不该再排下一轮。 */
export function isDeterministicAttachFailure(error: unknown): boolean {
  return (
    error instanceof NativeSessionConflictError ||
    error instanceof CliTranscriptNoTurnsError
  );
}

// attach 的正常出口。"empty" 不是错误：用户刚开一个 CLI pane、还没说第一句话时，
// transcript 就是合法的零轮次会话，跳过即可（文件长出真内容后再 attach）。
export type CliAttachOutcome = "attached" | "empty" | "ignored";
