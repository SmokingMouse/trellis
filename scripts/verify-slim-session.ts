// 端到端验证：直调 GET /api/sessions/[id] 与 GET /api/nodes/[id]/tool-calls，
// 对 BOE 大会话（91 节点）确认 toolCalls 已剥离、stats/generatedFiles 在位。
// 跑：TRELLIS_DB_PATH=/tmp/trellis-test.db bun --conditions=react-server scripts/verify-slim-session.ts

import { GET as getSession } from "@/app/api/sessions/[id]/route";
import { GET as getToolCalls } from "@/app/api/nodes/[id]/tool-calls/route";

const SID = "37f1e158-bfe2-4564-b49a-45767900d964";

let failures = 0;
function check(label: string, ok: boolean, got?: unknown) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(
      `  ✗ ${label}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`,
    );
  }
}

const res = await getSession(new Request("http://x"), {
  params: Promise.resolve({ id: SID }),
});
check("会话路由 200", res.status === 200, res.status);
const body = (await res.json()) as {
  session: unknown;
  nodes: Array<Record<string, unknown>>;
  notes: unknown;
};
check("返回 91 个节点", body.nodes.length === 91, body.nodes.length);

const raw = JSON.stringify(body);
console.log(`  瘦身后载荷: ${(raw.length / 1024).toFixed(1)} KB`);

const withToolCalls = body.nodes.filter(
  (n) => Array.isArray(n.toolCalls) && n.toolCalls.length > 0,
);
check("没有任何节点下发 toolCalls 数组", withToolCalls.length === 0, {
  nodesWithToolCalls: withToolCalls.length,
});

const withStats = body.nodes.filter((n) => n.toolCallStats != null);
check("节点带 toolCallStats", withStats.length > 0, withStats.length);
const sample = body.nodes.find((n) => {
  const s = n.toolCallStats as { total?: number } | undefined;
  return (s?.total ?? 0) > 0;
});
check(
  "至少一个节点 stats.total > 0",
  Boolean(sample),
  sample ? (sample.toolCallStats as { total: number }).total : undefined,
);

const withFiles = body.nodes.filter(
  (n) => Array.isArray(n.generatedFiles) && n.generatedFiles.length > 0,
);
check("有节点带 generatedFiles", withFiles.length > 0, withFiles.length);

// tools 字段：无委派节点的折叠摘要行靠它点名工具
const sampleNoDeleg = body.nodes.find((n) => {
  const s = n.toolCallStats as { total?: number; subagents?: number; tools?: string[] } | undefined;
  return (s?.total ?? 0) > 0 && (s?.subagents ?? 0) === 0 && Array.isArray(s?.tools) && s.tools.length > 0;
});
check(
  "无委派节点带 tools 顶层工具名",
  Boolean(sampleNoDeleg),
  sampleNoDeleg
    ? (sampleNoDeleg.toolCallStats as { tools: string[] }).tools
    : undefined,
);

// 按需端点：拿一个 stats.total>0 的节点，拉完整 toolCalls
if (sample) {
  const nodeId = sample.id as string;
  const total = (sample.toolCallStats as { total: number }).total;
  const res2 = await getToolCalls(new Request("http://x"), {
    params: Promise.resolve({ id: nodeId }),
  });
  check("tool-calls 端点 200", res2.status === 200, res2.status);
  const body2 = (await res2.json()) as { toolCalls?: unknown[] };
  check(
    "tool-calls 端点返回完整数组，长度与 stats.total 一致",
    Array.isArray(body2.toolCalls) && body2.toolCalls.length === total,
    { got: body2.toolCalls?.length, want: total },
  );
}

// 404 路径
const res3 = await getToolCalls(new Request("http://x"), {
  params: Promise.resolve({ id: "nonexistent-node" }),
});
check("未知节点 404", res3.status === 404, res3.status);

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
