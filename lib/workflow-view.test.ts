import { describe, expect, test } from "bun:test";
import { buildToolTree } from "@/lib/tool-tree";
import type { ToolCall, WorkflowProgressEntry } from "@/lib/types";
import {
  agentDetailRows,
  agentStateOf,
  buildWorkflowVM,
  columnsForWidth,
  GRID_THRESHOLD,
  hasValidWorkflowProgress,
  layoutAgents,
  MAX_ROWS,
  shortModelName,
  workflowStatusOf,
  type WorkflowAgentVM,
} from "@/lib/workflow-view";

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: "1",
  name: "Workflow",
  input: {},
  output: null,
  stderr: null,
  status: "done",
  durationMs: 10,
  startedAt: 1,
  endedAt: 2,
  ...over,
});

function node(progress: WorkflowProgressEntry[], over: Partial<ToolCall> = {}) {
  return buildToolTree([
    call({
      ...over,
      agent: {
        taskType: "local_workflow",
        workflowName: "wf",
        workflowProgress: progress,
        ...(over.agent ?? {}),
      },
    }),
  ])[0];
}

const agent = (
  over: Partial<WorkflowAgentVM["entry"]> & { index: number },
): WorkflowProgressEntry => ({
  type: "workflow_agent",
  label: `a-${over.index}`,
  ...over,
});

function vms(states: string[]): WorkflowAgentVM[] {
  return states.map((s, i) => ({
    entry: { type: "workflow_agent", index: i, label: `a-${i}`, state: s },
    state: agentStateOf(s),
    key: `k${i}`,
  }));
}

describe("agentStateOf", () => {
  test("已完成的两种写法都收进 done", () => {
    expect(agentStateOf("done")).toBe("done");
    expect(agentStateOf("completed")).toBe("done");
    expect(agentStateOf("DONE")).toBe("done");
  });

  test("失败 / 终止 / 排队各自的同义词", () => {
    expect(agentStateOf("failed")).toBe("failed");
    expect(agentStateOf("error")).toBe("failed");
    expect(agentStateOf("killed")).toBe("killed");
    expect(agentStateOf("cancelled")).toBe("killed");
    expect(agentStateOf("aborted")).toBe("killed");
    expect(agentStateOf("queued")).toBe("queued");
    expect(agentStateOf("pending")).toBe("queued");
  });

  test("未枚举的词一律算运行中，绝不当成完成", () => {
    expect(agentStateOf("start")).toBe("running");
    expect(agentStateOf("running")).toBe("running");
    expect(agentStateOf("some-future-word")).toBe("running");
    expect(agentStateOf(undefined)).toBe("running");
  });
});

describe("workflowStatusOf", () => {
  test("流里还在跑 = 运行中；流断了还挂着 = 已终止", () => {
    const n = node([], { status: "running" });
    expect(workflowStatusOf(n, true)).toBe("running");
    expect(workflowStatusOf(n, false)).toBe("killed");
  });

  test("工具报错、task 报 failed、任一 agent 失败，三条都算失败", () => {
    expect(workflowStatusOf(node([], { status: "error" }), false)).toBe("failed");
    expect(
      workflowStatusOf(node([], { agent: { status: "failed" } }), false),
    ).toBe("failed");
    expect(
      workflowStatusOf(node([agent({ index: 1, state: "failed" })]), false),
    ).toBe("failed");
  });

  test("其余是已完成", () => {
    expect(workflowStatusOf(node([agent({ index: 1, state: "done" })]), false)).toBe(
      "completed",
    );
  });
});

describe("buildWorkflowVM", () => {
  const vm = buildWorkflowVM(
    node([
      { type: "workflow_phase", index: 1, title: "Review" },
      { type: "workflow_phase", index: 2, title: "Verify" },
      agent({ index: 1, phaseIndex: 1, state: "done", durationMs: 1000 }),
      agent({ index: 2, phaseIndex: 1, state: "start" }),
      agent({ index: 3, phaseIndex: 2, state: "queued" }),
      // 没有 phaseIndex 的 agent 不许消失。
      agent({ index: 4, state: "done" }),
    ]),
    true,
  );

  test("阶段按快照顺序，loose agent 单独成段", () => {
    expect(vm.phases.map((p) => p.title)).toEqual(["Review", "Verify", "其他"]);
  });

  test("计数与进度", () => {
    expect(vm.total).toBe(4);
    expect(vm.done).toBe(2);
    expect(vm.percent).toBe(50);
  });

  test("含未完成 agent 的阶段默认展开，全排队 / 全完成的收起", () => {
    expect(vm.phases[0].defaultOpen).toBe(true);
    expect(vm.phases[1].defaultOpen).toBe(false);
    expect(vm.phases[2].defaultOpen).toBe(false);
  });

  test("阶段头文案", () => {
    expect(vm.phases[0].countText).toBe("1/2");
    expect(vm.phases[0].metaText).toContain("1 运行中");
    expect(vm.phases[1].metaText).toBe("全部排队中");
    expect(vm.phases[2].countText).toBe("1/1 完成");
  });

  test("阶段用时是墙钟，不是各 agent 耗时求和", () => {
    const p = buildWorkflowVM(
      node([
        { type: "workflow_phase", index: 1, title: "P" },
        agent({ index: 1, phaseIndex: 1, startedAt: 1000, lastProgressAt: 61000, durationMs: 60000 }),
        agent({ index: 2, phaseIndex: 1, startedAt: 1000, lastProgressAt: 61000, durationMs: 60000 }),
      ]),
      true,
    ).phases[0];
    expect(p.durationMs).toBe(60000);
  });

  test("没有快照 = 没有明细，交给兜底", () => {
    expect(buildWorkflowVM(node([]), false).hasDetail).toBe(false);
  });
});

describe("layoutAgents", () => {
  test(`超过 ${GRID_THRESHOLD} 个才分栏`, () => {
    expect(layoutAgents(vms(Array(GRID_THRESHOLD).fill("done"))).grid).toBe(false);
    expect(layoutAgents(vms(Array(GRID_THRESHOLD + 1).fill("done"))).grid).toBe(true);
  });

  test(`行数没超过 ${MAX_ROWS} 就不折叠`, () => {
    // 16 个分两栏 = 8 行。
    const l = layoutAgents(vms(Array(16).fill("done")));
    expect(l.grid).toBe(true);
    expect(l.folded).toHaveLength(0);
    expect(l.visible).toHaveLength(16);
  });

  test("分栏后仍超行时，尾部安静行折起来且总行数落回预算内", () => {
    const l = layoutAgents(vms(Array(30).fill("done")));
    expect(l.folded).toHaveLength(8);
    expect(l.visible).toHaveLength(22);
    // 22 个两栏 = 11 行，加上折叠按钮那一行正好 12。
    expect(Math.ceil(l.visible.length / 2) + 1).toBeLessThanOrEqual(MAX_ROWS);
    expect(l.moreLabel).toBe("… 还有 8 个已完成");
    expect(l.lessLabel).toBe("收起 8 个");
  });

  test("单栏列表永远不折叠 —— 分栏阈值比行预算低，撑不到那一步", () => {
    for (let n = 1; n <= GRID_THRESHOLD; n++) {
      const l = layoutAgents(vms(Array(n).fill("queued")));
      expect(l.grid).toBe(false);
      expect(l.folded).toHaveLength(0);
    }
  });

  test("running / failed 永不被折叠 —— 尾部撞上它们就停手", () => {
    const states = [...Array(29).fill("done"), "running"];
    const l = layoutAgents(vms(states));
    expect(l.folded).toHaveLength(0);
    const states2 = [...Array(25).fill("done"), "failed", ...Array(4).fill("done")];
    const l2 = layoutAgents(vms(states2));
    expect(l2.folded).toHaveLength(4);
    expect(l2.folded.every((a) => a.state === "done")).toBe(true);
  });

  test("混合状态的折叠文案逐类点名", () => {
    const l = layoutAgents(
      vms([...Array(22).fill("done"), ...Array(4).fill("done"), ...Array(4).fill("queued")]),
    );
    expect(l.moreLabel).toBe("… 还有 8 个（4 已完成 / 4 排队中）");
  });

  // 12 行预算说的是**屏幕上**的 12 行。栏数由 CSS auto-fill 决定，写死两栏的
  // 后果是：手机一栏时 24 个 agent 当成 12 行原样铺开（实际 24 行），桌面四栏
  // 时 30 个当成 15 行去折（实际 8 行，根本不该折）。
  describe(`预算按实际列数算（恰好 ${MAX_ROWS} 行不折、再多一行才折）`, () => {
    for (const columns of [1, 2, 3]) {
      const exact = MAX_ROWS * columns;
      test(`${columns} 栏：${exact} 个正好 ${MAX_ROWS} 行，不折`, () => {
        const l = layoutAgents(vms(Array(exact).fill("done")), columns);
        expect(l.folded).toHaveLength(0);
        expect(l.visible).toHaveLength(exact);
      });

      test(`${columns} 栏：${exact + 1} 个多出一行，折尾`, () => {
        const l = layoutAgents(vms(Array(exact + 1).fill("done")), columns);
        expect(l.folded.length).toBeGreaterThan(0);
        // 折叠按钮自己占一行，可见行数加上它仍在预算内。
        expect(Math.ceil(l.visible.length / columns) + 1).toBeLessThanOrEqual(MAX_ROWS);
      });
    }

    test("缺省仍是两栏 —— SSR 与首帧量不到宽度时的桌面假设", () => {
      expect(layoutAgents(vms(Array(25).fill("done"))).folded).toHaveLength(
        layoutAgents(vms(Array(25).fill("done")), 2).folded.length,
      );
      expect(layoutAgents(vms(Array(24).fill("done"))).folded).toHaveLength(0);
    });

    test("单栏时 running / failed 尾巴照样不折", () => {
      const l = layoutAgents(vms([...Array(20).fill("done"), "running"]), 1);
      expect(l.folded).toHaveLength(0);
    });

    test("栏数是脏值时不算出 NaN 行（NaN 退回 2 栏，0 夹到 1 栏）", () => {
      const dirty = layoutAgents(vms(Array(25).fill("done")), Number.NaN);
      expect(dirty.visible).toHaveLength(22);
      expect(layoutAgents(vms(Array(25).fill("done")), 0).visible).toHaveLength(11);
    });
  });
});

describe("columnsForWidth", () => {
  test("按 280px 最小栏宽 + 16px 间距反算 auto-fill 的栏数", () => {
    expect(columnsForWidth(390)).toBe(1);
    expect(columnsForWidth(279)).toBe(1);
    expect(columnsForWidth(280)).toBe(1);
    expect(columnsForWidth(576)).toBe(2);
    expect(columnsForWidth(575)).toBe(1);
    expect(columnsForWidth(872)).toBe(3);
    expect(columnsForWidth(1200)).toBe(4);
  });

  test("量不到宽度（SSR / 未挂载 / 0）按两栏", () => {
    expect(columnsForWidth(null)).toBe(2);
    expect(columnsForWidth(undefined)).toBe(2);
    expect(columnsForWidth(0)).toBe(2);
    expect(columnsForWidth(Number.NaN)).toBe(2);
  });
});

// 快照是 CLI 原样落库的 JSON，形状不由我们保证。一处不合规整份作废 ——
// 表头 / 正文 / 面包屑共用这一个守卫，半份快照算出来的进度是骗人的。
describe("hasValidWorkflowProgress", () => {
  const raw = (progress: unknown) =>
    buildToolTree([
      call({
        agent: {
          taskType: "local_workflow",
          workflowName: "wf",
          workflowProgress: progress as never,
        },
      }),
    ])[0];

  test("没有快照不算畸形 —— 那是老 daemon / 还没来", () => {
    expect(hasValidWorkflowProgress(raw(undefined))).toBe(true);
    expect(hasValidWorkflowProgress(raw(null))).toBe(true);
    expect(hasValidWorkflowProgress(raw([]))).toBe(true);
  });

  test("非数组一律作废，且取阶段 / agent 不抛", () => {
    for (const bad of [{}, "progress", 42, true]) {
      expect(hasValidWorkflowProgress(raw(bad))).toBe(false);
      expect(() => buildWorkflowVM(raw(bad), false)).not.toThrow();
      expect(buildWorkflowVM(raw(bad), false).hasDetail).toBe(false);
    }
  });

  test("缺 title 的阶段 / 缺 label 的 agent 作废", () => {
    expect(hasValidWorkflowProgress(raw([{ type: "workflow_phase", index: 1 }]))).toBe(false);
    expect(
      hasValidWorkflowProgress(raw([{ type: "workflow_phase", index: 1, title: 7 }])),
    ).toBe(false);
    expect(
      hasValidWorkflowProgress(raw([{ type: "workflow_phase", title: "Alpha" }])),
    ).toBe(false);
    expect(
      hasValidWorkflowProgress(raw([{ type: "workflow_agent", index: 1, state: "running" }])),
    ).toBe(false);
    expect(hasValidWorkflowProgress(raw([null]))).toBe(false);
  });

  test("形状对的快照照旧放行", () => {
    expect(
      hasValidWorkflowProgress(
        raw([
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_agent", index: 2, phaseIndex: 1, label: "a-1", state: "done" },
        ]),
      ),
    ).toBe(true);
  });

  test("将来新增的 entry 类型只是被忽略，不算畸形", () => {
    const n = raw([
      { type: "workflow_phase", index: 1, title: "Alpha" },
      { type: "workflow_checkpoint", index: 9 },
    ]);
    expect(hasValidWorkflowProgress(n)).toBe(true);
    expect(buildWorkflowVM(n, false).phases).toHaveLength(1);
  });
});

describe("shortModelName", () => {
  test("砍厂商前缀与日期后缀，别的不动", () => {
    expect(shortModelName("claude-opus-5[1m]")).toBe("opus-5[1m]");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModelName("gemini-flash")).toBe("gemini-flash");
    expect(shortModelName(undefined)).toBeNull();
  });
});

describe("agentDetailRows", () => {
  const rows = agentDetailRows(
    {
      entry: {
        type: "workflow_agent",
        index: 1,
        label: "a",
        model: "claude-opus-5[1m]",
        fallbackModel: "claude-sonnet-5",
        attempt: 2,
        queuedAt: 0,
        durationMs: 8855,
        tokens: 25175,
        toolCalls: 3,
      },
      state: "done",
      key: "k",
    },
    "Review",
  );
  const get = (label: string) => rows.find((r) => r.label === label);

  test("降级显示的是实际用的模型，原模型进 title", () => {
    expect(get("模型")?.value).toContain("sonnet-5");
    expect(get("模型")?.title).toBe("降级自 claude-opus-5[1m]");
  });

  test("缺失的时间戳写「—」，不编", () => {
    expect(get("排队于")?.value).toBe("—");
    expect(get("开始于")?.value).toBe("—");
  });

  test("阶段 / 尝试 / 状态 / 耗时 / token / 工具调用都在", () => {
    expect(get("阶段")?.value).toBe("Review");
    expect(get("尝试")?.value).toBe("第 2 次");
    expect(get("状态")?.value).toBe("已完成");
    expect(get("耗时")?.value).toBe("8.9 s");
    expect(get("token")?.value).toBe("25175");
    expect(get("工具调用")?.value).toBe("3");
  });
});
