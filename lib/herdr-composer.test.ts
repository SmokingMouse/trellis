import { describe, expect, test } from "bun:test";
import {
  herdrComposerHint,
  insertPathAt,
  quotePath,
  reconcileHerdrQueue,
  restoreDraft,
  type HerdrQueuedInput,
} from "./herdr-composer";

describe("Herdr 输入框纯逻辑", () => {
  test("提示行与常规输入框同构，跟随发送键偏好", () => {
    expect(herdrComposerHint("mod-enter")).toBe("⌘↩ 发送 · ↩ 换行 · 输入 / 调出 Claude 命令 · 可粘贴图片");
    expect(herdrComposerHint("enter")).toStartWith("↩ 发送 · ⇧↩ 换行");
  });

  test("路径插入：光标处、两侧补空格、含空格的路径加引号", () => {
    expect(insertPathAt("", "/a/b.png", null)).toEqual({ text: "/a/b.png ", caret: 9 });
    expect(insertPathAt("看这张图", "/a/b.png", null).text).toBe("看这张图 /a/b.png ");
    expect(insertPathAt("前后", "/x.png", 1)).toEqual({ text: "前 /x.png 后", caret: 9 });
    expect(insertPathAt("前 后", "/x.png", 2).text).toBe("前 /x.png 后");
    expect(quotePath("/Users/me/My Shots/a.png")).toBe('"/Users/me/My Shots/a.png"');
    expect(insertPathAt("x", "/p q.png", 99).text).toBe('x "/p q.png" ');
  });

  test("排队对账：送达 / 撤回移除，失败与过期交还文本", () => {
    const item = (id: string, queuedAt = 0): HerdrQueuedInput => ({ inputId: id, paneId: "p", text: `t-${id}`, queuedAt });
    const queue = [item("a"), item("b"), item("c"), item("d"), item("e", 9_000)];
    const result = reconcileHerdrQueue(
      queue,
      [
        { inputId: "a", paneId: "p", status: "queued" },
        { inputId: "b", paneId: "p", status: "delivered" },
        { inputId: "c", paneId: "p", status: "failed", error: "x" },
        { inputId: "d", paneId: "p", status: "cancelled" },
      ],
      20_000,
    );
    expect(result.queue.map((q) => q.inputId)).toEqual(["a", "e"]);
    expect(result.delivered.map((q) => q.inputId)).toEqual(["b"]);
    expect(result.failed.map((q) => q.inputId)).toEqual(["c"]);
    // 回执缺失超过 15s → 视同失败
    expect(reconcileHerdrQueue([item("z", 0)], [], 20_000).failed.map((q) => q.inputId)).toEqual(["z"]);
  });

  test("放回输入框不覆盖新草稿", () => {
    expect(restoreDraft("", "旧消息")).toBe("旧消息");
    expect(restoreDraft("新草稿 ", "旧消息")).toBe("新草稿\n旧消息");
    expect(restoreDraft("含旧消息的草稿", "旧消息")).toBe("含旧消息的草稿");
  });
});
