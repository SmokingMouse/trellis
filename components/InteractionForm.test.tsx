import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionForm } from "./InteractionForm";

test("审批动作主次明确：允许一次、拒绝、低权重总是允许且手机保留触控高度", () => {
  const html = renderToStaticMarkup(<InteractionForm nodeId="test" interaction={{toolUseId:"a",toolName:"Bash",input:{command:"echo safe"}}} />);
  const button = (name: string) => html.match(new RegExp(`<button[^>]*data-mobile-target="permission-${name}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
  expect(button("allow")).toContain("bg-accent ");
  expect(button("allow")).toContain("允许一次");
  expect(button("deny")).toContain("border-line-strong");
  expect(button("always")).not.toContain("bg-accent");
  expect(button("always")).not.toContain("w-full");
  for (const name of ["allow", "deny", "always"]) expect(button(name)).toContain("min-h-11");
  expect(html.indexOf('permission-allow')).toBeLessThan(html.indexOf('permission-deny'));
  expect(html.indexOf('permission-deny')).toBeLessThan(html.indexOf('permission-always'));
});
