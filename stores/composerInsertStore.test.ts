import { describe, expect, it } from "bun:test";
import { appendToDraft, useComposerInsertStore } from "./composerInsertStore";

describe("composer insert mailbox", () => {
  it("appends after an existing draft with a blank line, or replaces an empty one", () => {
    expect(appendToDraft("", "msg")).toBe("msg");
    expect(appendToDraft("  \n", "msg")).toBe("msg");
    expect(appendToDraft("hello\n", "msg")).toBe("hello\n\nmsg");
  });

  it("consume only clears the matching delivery", () => {
    const s = useComposerInsertStore.getState();
    s.queueComposerInsert("s1", "a");
    const first = useComposerInsertStore.getState().pending!;
    s.queueComposerInsert("s1", "b");
    s.consumeComposerInsert(first.id);
    expect(useComposerInsertStore.getState().pending?.text).toBe("b");
    s.consumeComposerInsert(useComposerInsertStore.getState().pending!.id);
    expect(useComposerInsertStore.getState().pending).toBeNull();
  });
});
