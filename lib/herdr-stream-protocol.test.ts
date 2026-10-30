import { describe, expect, test } from "bun:test";
import {
  BACKPRESSURE_HIGH,
  BACKPRESSURE_LOW,
  FrameCoalescer,
  LineSplitter,
  PASTE_LIMIT_BYTES,
  backpressureAction,
  isValidPaneId,
  parseClientMessage,
  parseObserveLine,
  parseStreamParams,
  preparePaste,
  splitInput,
  type ObserveFrame,
} from "./herdr-stream-protocol";

// herdr 0.9.3 `terminal session observe w4:p2K --cols 60 --rows 12` 实录的一行差分帧。
const REAL_DIFF_LINE =
  '{"bytes":"G1s/MjAyNmgbWz8yNWwbXTg7OxtcG1s3OzE2SBtbMDszOTs0OW1lY2hvG1s3OzIxSGgbWzBtG1s3OzIySBtbPzI1aBtbPzIwMjZsG1s3OzIySBtbPzI1aA==","encoding":"ansi","full":false,"height":12,"seq":2,"type":"terminal.frame","width":60}';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const frame = (s: string, full = false, cols = 80, rows = 24): ObserveFrame => ({
  kind: "frame",
  seq: 0,
  cols,
  rows,
  full,
  bytes: new TextEncoder().encode(s),
});

describe("parseObserveLine", () => {
  test("真实差分帧：解 base64、带尺寸", () => {
    const ev = parseObserveLine(REAL_DIFF_LINE);
    expect(ev?.kind).toBe("frame");
    if (ev?.kind !== "frame") return;
    expect(ev).toMatchObject({ seq: 2, cols: 60, rows: 12, full: false });
    const s = text(ev.bytes);
    expect(s.startsWith("\x1b[?2026h")).toBe(true);
    expect(s).toContain("echo");
  });

  test("terminal.closed 带原因", () => {
    expect(
      parseObserveLine('{"reason":"terminal attach ended: terminal term_x not found","type":"terminal.closed"}'),
    ).toEqual({ kind: "closed", reason: "terminal attach ended: terminal term_x not found" });
  });

  test("坏行 / 未知事件 / 尺寸非法 → null，不掐流", () => {
    expect(parseObserveLine("")).toBeNull();
    expect(parseObserveLine("not json")).toBeNull();
    expect(parseObserveLine('{"type":"terminal.hello"}')).toBeNull();
    expect(parseObserveLine('{"type":"terminal.frame","encoding":"ansi","bytes":"AA==","width":0,"height":5}')).toBeNull();
    expect(parseObserveLine('{"type":"terminal.frame","encoding":"utf16","bytes":"AA==","width":5,"height":5}')).toBeNull();
    expect(parseObserveLine('{"type":"terminal.frame","encoding":"ansi","bytes":"@@@","width":5,"height":5}')).toBeNull();
  });
});

describe("LineSplitter", () => {
  test("半行 / 多行 / 跨块的中文都切对", () => {
    const sp = new LineSplitter();
    const enc = new TextEncoder();
    const all = enc.encode('{"a":"中文"}\n{"b":1}\n{"c"');
    expect(sp.push(all.slice(0, 7))).toEqual([]); // 切在「中」的 UTF-8 中间
    expect(sp.push(all.slice(7))).toEqual(['{"a":"中文"}', '{"b":1}']);
    expect(sp.push(enc.encode(":2}\n"))).toEqual(['{"c":2}']);
  });

  test("没有换行却超长的垃圾被丢弃", () => {
    const sp = new LineSplitter(10);
    sp.push(new TextEncoder().encode("x".repeat(20)));
    expect(sp.push(new TextEncoder().encode("ok\n"))).toEqual(["ok"]);
  });
});

describe("FrameCoalescer", () => {
  test("差分按序拼接，尺寸跟最后一帧", () => {
    const c = new FrameCoalescer();
    c.push(frame("a", false, 80, 24));
    c.push(frame("b", false, 100, 30));
    const out = c.take();
    expect(text(out!.bytes)).toBe("ab");
    expect(out).toMatchObject({ full: false, cols: 100, rows: 30 });
    expect(c.take()).toBeNull();
  });

  test("full 帧作废之前攒的差分", () => {
    const c = new FrameCoalescer();
    c.push(frame("old"));
    c.push(frame("FULL", true));
    c.push(frame("+d"));
    const out = c.take();
    expect(text(out!.bytes)).toBe("FULL+d");
    expect(out!.full).toBe(true);
  });
});

describe("backpressureAction", () => {
  test("正常发送 → 超高水位停流 → 等到低水位以下恢复", () => {
    expect(backpressureAction(0, false)).toBe("send");
    expect(backpressureAction(BACKPRESSURE_HIGH, false)).toBe("send");
    expect(backpressureAction(BACKPRESSURE_HIGH + 1, false)).toBe("stall");
    expect(backpressureAction(BACKPRESSURE_LOW + 1, true)).toBe("wait");
    expect(backpressureAction(BACKPRESSURE_LOW, true)).toBe("resume");
  });
});

describe("参数校验", () => {
  test("窗格 id", () => {
    expect(isValidPaneId("w4:p2K")).toBe(true);
    expect(isValidPaneId("w3F:p1")).toBe(true);
    expect(isValidPaneId("-rf")).toBe(false);
    expect(isValidPaneId("w4 p2")).toBe(false);
    expect(isValidPaneId("")).toBe(false);
    expect(isValidPaneId(42)).toBe(false);
  });

  test("查询串：pane 必填，cols/rows 要么都不给要么都在范围内", () => {
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K"))).toEqual({ ok: true, paneId: "w4:p2K", hint: null });
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K&cols=80&rows=24"))).toEqual({
      ok: true,
      paneId: "w4:p2K",
      hint: { cols: 80, rows: 24 },
    });
    expect(parseStreamParams(new URLSearchParams("cols=80&rows=24")).ok).toBe(false);
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K&cols=80")).ok).toBe(false);
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K&cols=19&rows=24")).ok).toBe(false);
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K&cols=80&rows=201")).ok).toBe(false);
    expect(parseStreamParams(new URLSearchParams("pane=w4:p2K&cols=8e1&rows=24")).ok).toBe(false);
  });

  test("客户端消息", () => {
    expect(parseClientMessage('{"t":"input","data":"ls\\r"}')).toEqual({ t: "input", data: "ls\r" });
    expect(parseClientMessage('{"t":"key","key":"shift+enter"}')).toEqual({ t: "key", key: "shift+enter" });
    expect(parseClientMessage('{"t":"key","key":"Home"}')).toHaveProperty("error");
    expect(parseClientMessage('{"t":"scroll","offset":12}')).toEqual({ t: "scroll", offset: 12 });
    expect(parseClientMessage('{"t":"scroll","offset":-1}')).toHaveProperty("error");
    expect(parseClientMessage('{"t":"resize","cols":80,"rows":24}')).toEqual({ t: "resize", cols: 80, rows: 24 });
    expect(parseClientMessage('{"t":"resize","cols":1000,"rows":24}')).toHaveProperty("error");
    expect(parseClientMessage('{"t":"input","data":""}')).toHaveProperty("error");
    expect(parseClientMessage('{"t":"nope"}')).toHaveProperty("error");
    expect(parseClientMessage("[]")).toHaveProperty("error");
    expect(parseClientMessage("{")).toHaveProperty("error");
    // 256 KiB 按 UTF-8 算：中文 3 字节一个。
    const big = "中".repeat(Math.floor(PASTE_LIMIT_BYTES / 3) + 1);
    expect(parseClientMessage(JSON.stringify({ t: "paste", data: big }))).toHaveProperty("error");
  });
});

describe("splitInput", () => {
  test("普通字节（含控制字符）原样走 send_text", () => {
    expect(splitInput("ls -la\r")).toEqual([{ text: "ls -la\r" }]);
    expect(splitInput("\x03")).toEqual([{ text: "\x03" }]);
    expect(splitInput("\x1b[3~")).toEqual([{ text: "\x1b[3~" }]);
  });

  test("方向键（两种光标模式）交给 herdr 编码，相邻的合并、顺序不乱", () => {
    expect(splitInput("\x1b[A")).toEqual([{ keys: ["up"] }]);
    expect(splitInput("\x1bOD")).toEqual([{ keys: ["left"] }]);
    expect(splitInput("a\x1b[A\x1b[Bb")).toEqual([{ text: "a" }, { keys: ["up", "down"] }, { text: "b" }]);
    // 带修饰的方向键与模式无关，直发字节。
    expect(splitInput("\x1b[1;5D")).toEqual([{ text: "\x1b[1;5D" }]);
  });

  test("大文本切块且不劈开代理对", () => {
    const s = "a".repeat(64 * 1024 - 1) + "😀" + "b";
    const segs = splitInput(s);
    expect(segs.length).toBe(2);
    expect(segs.map((x) => ("text" in x ? x.text : "")).join("")).toBe(s);
    const first = (segs[0] as { text: string }).text;
    expect(first.endsWith("a")).toBe(true);
  });
});

describe("preparePaste", () => {
  test("单行不包粘贴框；正文 ESC 换成 ␛", () => {
    expect(preparePaste("echo hi")).toBe("echo hi");
    expect(preparePaste("x\x1b[201~rm -rf /")).toBe("x␛[201~rm -rf /");
  });

  test("多行包 bracketed paste，换行统一成 \\r", () => {
    expect(preparePaste("a\nb\r\nc")).toBe("\x1b[200~a\rb\rc\x1b[201~");
  });

  test("粘贴进 splitInput 不会被误拆成方向键", () => {
    expect(splitInput(preparePaste("\x1b[A"))).toEqual([{ text: "␛[A" }]);
  });
});
