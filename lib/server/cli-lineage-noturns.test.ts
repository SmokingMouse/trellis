// 根因 C 的另一半：「选中文件解析不出轮次」必须是**确定性**错误类型。
//
// 原先这里抛的是裸 Error，herdr-fleet 的 isDeterministicAttachFailure 认不出来，
// 于是每轮 snapshot 都重排一次 attach —— 符号链接路径失配把这条路踩成了无限重试。
// 路径已经在 canonical-path 那层收口，这条用例守的是**出口类型**：将来别的原因
// （文件在发现窗口内被换掉、被截断重写…）走到同一个 throw 时，也不能再退化成
// 无限重试。
import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const { discoverLineage } = await import("./cli-discover");
const { CliTranscriptNoTurnsError, isDeterministicAttachFailure } = await import(
  "./cli-attach"
);

const tempRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "trellis-noturns-")),
);

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("选中的 jsonl 解析不出轮次 → 确定性错误类型，herdr-fleet 跳过而非重试", () => {
  const file = path.join(tempRoot, "no-turns.jsonl");
  // 合法 JSON 行，但一条 turn 都产不出（只有噪声行）。
  fs.writeFileSync(
    file,
    [
      { type: "mode", mode: "default", sessionId: "s-noturns", cwd: tempRoot },
      { type: "file-history-snapshot", messageId: "m1", snapshot: { trackedFileBackups: {} } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  let thrown: unknown;
  try {
    discoverLineage(file, "claude");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliTranscriptNoTurnsError);
  expect((thrown as InstanceType<typeof CliTranscriptNoTurnsError>).transcriptPath).toBe(file);
  // 这是判据本身：fleet 的重试闸只看这个函数。
  expect(isDeterministicAttachFailure(thrown)).toBe(true);
  // 对照：可重试的那一类不能被误判成确定性。
  expect(isDeterministicAttachFailure(new Error("transcript unreadable"))).toBe(false);
});
