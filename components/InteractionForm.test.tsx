import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionForm } from "./InteractionForm";

test("审批动作主次明确：允许一次为主按钮、作用域是次级分段选择、拒绝描边，手机保留触控高度", () => {
  const html = renderToStaticMarkup(<InteractionForm nodeId="test" interaction={{toolUseId:"a",toolName:"Bash",input:{command:"echo safe"}}} />);
  const button = (name: string) => html.match(new RegExp(`<button[^>]*data-mobile-target="permission-${name}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
  // 主按钮 = 墨色实底（51ca749 起 primary 不再是亮蓝）
  expect(button("allow")).toContain("bg-ink ");
  expect(button("allow")).toContain("允许一次");
  expect(button("allow")).toContain('data-scope="once"');
  expect(button("deny")).toContain("shadow-btn");
  for (const name of ["allow", "deny"]) expect(button(name)).toContain("min-h-11");
  // 作用域：radiogroup 三档，缺省「仅本次」，每档手机 44px
  const scope = html.match(/<div[^>]*data-mobile-target="permission-scope"[\s\S]*?<\/div><\/div>/)?.[0] ?? "";
  expect(scope).toContain('role="radiogroup"');
  for (const label of ["仅本次", "本会话", "所有会话"]) expect(scope).toContain(label);
  expect(scope).toMatch(/aria-checked="true"[^>]*data-value="once"/);
  expect((scope.match(/max-md:min-h-11/g) ?? []).length).toBe(3);
  expect(scope).not.toContain("bg-ink ");
  expect(scope).not.toContain("bg-accent");
  // 仅本次时不出规则预览；顺序：作用域 → 允许 → 拒绝
  expect(html).not.toContain("data-approval-rule-preview");
  expect(html.indexOf("permission-scope")).toBeLessThan(html.indexOf("permission-allow"));
  expect(html.indexOf("permission-allow")).toBeLessThan(html.indexOf("permission-deny"));
  expect(html).not.toContain("permission-always");
});

test("问答类交互不出作用域选择", () => {
  const html = renderToStaticMarkup(<InteractionForm nodeId="test" interaction={{toolUseId:"a",toolName:"ExitPlanMode",input:{plan:"x"}}} />);
  expect(html).not.toContain("permission-scope");
});
