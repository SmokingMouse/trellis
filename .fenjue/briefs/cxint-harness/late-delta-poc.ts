// PoC: after interruptIncomplete(), any late native delta for that item becomes a
// mapper-fatal error. Pre-fix the same frame was harmless.
const root = process.argv[2] ?? "/Users/smokingmouse/.herdr/worktrees/sm-toolkit/cxint-review";
const { CodexEventMapper } = await import(`${root}/packages/agent-server/dist/engines/codex-mapper.js`);

const m = new CodexEventMapper();
m.beginTurn("tn_1");
m.map("item/started", { item: { id: "exec-1", type: "commandExecution", command: "sleep 600", cwd: "/tmp" } });
if (typeof m.interruptIncomplete === "function") {
  const events = m.interruptIncomplete();
  console.log("interruptIncomplete ->", JSON.stringify(events.map((e: any) => [e.type, e.item?.status])));
} else {
  console.log("interruptIncomplete -> absent (pre-fix build)");
}
try {
  const out = m.map("item/commandExecution/outputDelta", { itemId: "exec-1", delta: "late output\n" });
  console.log("late delta -> OK", JSON.stringify(out.map((e: any) => e.type)));
} catch (error: any) {
  console.log("late delta -> THROWS", error.code, error.message);
}
// A late native item/completed after the synthesized one duplicates itemCompleted.
const again = m.map("item/completed", { item: { id: "exec-1", type: "commandExecution", command: "sleep 600", cwd: "/tmp", exitCode: 130, status: "interrupted" } });
console.log("late native item/completed ->", JSON.stringify(again.map((e: any) => [e.type, e.item?.status])));
