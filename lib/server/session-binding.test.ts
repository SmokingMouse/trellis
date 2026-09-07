import { expect, test, mock } from "bun:test";
mock.module("server-only", () => ({}));
const { parseSessionBinding, newProjectBinding } = await import("./session-binding");
test("legacy default, reserved pane and daemon scoped thread stay distinct", () => {
  expect(parseSessionBinding({id:"s"},"daemon")).toEqual({type:"legacy"});
  expect(parseSessionBinding({id:"s",bindingType:"pane"},"daemon")).toEqual({type:"pane",sessionId:"s"});
  expect(parseSessionBinding({id:"s",bindingType:"thread"},"daemon")).toEqual({type:"thread",sessionId:"s",daemonId:"daemon"});
  expect(() => parseSessionBinding({id:"s",bindingType:"unknown"},"daemon")).toThrow();
});
test("only new project sessions with both switches opt in; custom agent remains legacy", () => {
  const old = {a:process.env.TRELLIS_AS,b:process.env.TRELLIS_AS_PROJECT};
  try {
    process.env.TRELLIS_AS="on"; process.env.TRELLIS_AS_PROJECT="on";
    expect(newProjectBinding("project")).toBe("thread");
    expect(newProjectBinding("chat")).toBe("legacy");
    expect(newProjectBinding("project","agent")).toBe("legacy");
    process.env.TRELLIS_AS_PROJECT="off"; expect(newProjectBinding("project")).toBe("legacy");
  } finally {
    if(old.a===undefined) delete process.env.TRELLIS_AS; else process.env.TRELLIS_AS=old.a;
    if(old.b===undefined) delete process.env.TRELLIS_AS_PROJECT; else process.env.TRELLIS_AS_PROJECT=old.b;
  }
});
