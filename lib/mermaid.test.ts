import { describe, expect, test } from "bun:test";
import {
  describeMermaidError,
  isMermaidCode,
  isMermaidLang,
  normalizeMermaidSource,
  withIntrinsicSize,
} from "./mermaid";
import { readSvgSize, svgToDataUrl } from "./svg";

describe("isMermaidLang / isMermaidCode", () => {
  test("mermaid / mmd 语言标记，大小写无关", () => {
    expect(isMermaidLang("mermaid")).toBe(true);
    expect(isMermaidLang("Mermaid")).toBe(true);
    expect(isMermaidLang("mmd")).toBe(true);
    expect(isMermaidLang("markdown")).toBe(false);
  });
  test("无语言标记时按首行图表声明识别", () => {
    expect(isMermaidCode("graph TD\n  A-->B", "")).toBe(true);
    expect(isMermaidCode("sequenceDiagram\n  A->>B: hi", "")).toBe(true);
    expect(isMermaidCode("const a = 1", "javascript")).toBe(false);
  });
});

describe("withIntrinsicSize", () => {
  // mermaid useMaxWidth 默认产物的根节点形态
  const svg =
    '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 812.5px;" viewBox="-8 -8 812.5 430" role="graphics-document document"><g/></svg>';

  test("按 viewBox 回填宽高，去掉 width=100% 与 max-width", () => {
    const out = withIntrinsicSize(svg);
    expect(out.width).toBe(812.5);
    expect(out.height).toBe(430);
    expect(out.svg).toStartWith('<svg width="812.5" height="430" id="m1"');
    expect(out.svg).not.toContain('width="100%"');
    expect(out.svg).not.toContain("max-width");
    expect(out.svg).toEndWith("<g/></svg>");
  });

  test("保留 style 里的其它声明", () => {
    const out = withIntrinsicSize(svg.replace("max-width: 812.5px;", "max-width: 812.5px; background-color: white;"));
    expect(out.svg).toContain('style="background-color: white;"');
  });

  test("单引号 viewBox 也认", () => {
    expect(withIntrinsicSize("<svg viewBox='0 0 640 480'><g/></svg>").width).toBe(640);
  });

  test("没有 viewBox 原样返回、尺寸 0", () => {
    const raw = '<svg width="100%"><g/></svg>';
    expect(withIntrinsicSize(raw)).toEqual({ svg: raw, width: 0, height: 0 });
  });

  test("幂等", () => {
    const once = withIntrinsicSize(svg);
    expect(withIntrinsicSize(once.svg)).toEqual(once);
  });
});

describe("describeMermaidError", () => {
  test("jison 语法错误 → 行号标题 + 原文详情", () => {
    const raw =
      "Parse error on line 3:\n...B --> C[foo (bar)]\n----------------------^\nExpecting 'SQE', got 'PS'";
    const out = describeMermaidError(new Error(raw));
    expect(out.error).toBe("第 3 行附近语法错误");
    expect(out.detail).toBe(raw);
  });
  test("无法识别图表类型", () => {
    const out = describeMermaidError(
      new Error("No diagram type detected matching given configuration for text: hello"),
    );
    expect(out.error).toContain("无法识别图表类型");
  });
  test("词法错误", () => {
    expect(describeMermaidError(new Error("Lexical error on line 2. Unrecognized text.")).error).toBe(
      "第 2 行有无法识别的字符",
    );
  });
  test("空错误兜底", () => {
    expect(describeMermaidError(undefined)).toEqual({ error: "Mermaid 渲染失败" });
  });
});

describe("normalizeMermaidSource（S132 回归）", () => {
  test("flowchart 裸特殊字符 label 加引号", () => {
    const src = "flowchart TD\n  A{在 [L_i ... L_{i+k}] 中?} --> B[状态 (有全景无前景)]";
    expect(normalizeMermaidSource(src)).toBe(
      'flowchart TD\n  A{"在 [L_i ... L_{i+k}] 中?"} --> B["状态 (有全景无前景)"]',
    );
  });
  test("标准源原样透传、幂等", () => {
    const src = 'flowchart LR\n  A["已引号 (ok)"] --> B[普通]\n  B --> C';
    expect(normalizeMermaidSource(src)).toBe(src);
    const dialect = "graph TD\n  A[x (y)] --> B";
    const once = normalizeMermaidSource(dialect);
    expect(normalizeMermaidSource(once)).toBe(once);
  });
  test("非 flowchart / 时序图不动", () => {
    const src = "classDiagram\n  class 用户 {\n    +登录()\n  }";
    expect(normalizeMermaidSource(src)).toBe(src);
    const seq = "sequenceDiagram\n  A->>B: call (x)";
    expect(normalizeMermaidSource(seq)).toBe(seq);
  });
});

describe("normalizeMermaidSource：方言规则", () => {
  const norm = normalizeMermaidSource;
  const idempotent = (src: string) => expect(norm(norm(src))).toBe(norm(src));

  test("YAML frontmatter 不挡住 flowchart 识别", () => {
    const src = "---\ntitle: 架构\n---\nflowchart TD\n  A[x (y)] --> B";
    expect(norm(src)).toBe('---\ntitle: 架构\n---\nflowchart TD\n  A["x (y)"] --> B');
  });

  test("HTML 注释：整行换成 %%（行号不变），行内的去掉", () => {
    const src = "<!-- 调用时序 -->\nsequenceDiagram\n  A->>B: hi <!-- 备注 -->";
    expect(norm(src)).toBe("%%\nsequenceDiagram\n  A->>B: hi ");
    const multi = "<!--\n多行\n-->\nflowchart TD\n  A --> B";
    expect(norm(multi)).toBe("%%\n%%\n%%\nflowchart TD\n  A --> B");
  });

  test("中文节点 id 的 label 同样加引号", () => {
    expect(norm("flowchart TD\n  开始[流程开始 (A)] --> 结束")).toBe('flowchart TD\n  开始["流程开始 (A)"] --> 结束');
  });

  test("label 里的 & 不再被当成并联符切开", () => {
    expect(norm("flowchart TD\n  A[R&D (一期)] & C --> B")).toBe('flowchart TD\n  A["R&D (一期)"] & C --> B');
  });

  test("小写 end 当节点 id → End，subgraph 的 end 不动", () => {
    const src = "flowchart TD\n  subgraph S\n    A --> end[完成]\n  end\n  end --> X\n  style end fill:#fff\n  class A,end hot";
    expect(norm(src)).toBe(
      "flowchart TD\n  subgraph S\n    A --> End[完成]\n  end\n  End --> X\n  style End fill:#fff\n  class A,End hot",
    );
    idempotent(src);
  });

  test("subgraph 标题含特殊字符加引号（带 id / 不带 id）", () => {
    expect(norm("flowchart TD\n  subgraph G0[阶段 1 (核心)]\n  end")).toBe('flowchart TD\n  subgraph G0["阶段 1 (核心)"]\n  end');
    expect(norm("flowchart TD\n  subgraph 阶段 1 (核心)\n  end")).toBe('flowchart TD\n  subgraph "阶段 1 (核心)"\n  end');
    const ok = "flowchart TD\n  subgraph G1 [阶段 1：处理层]\n  end";
    expect(norm(ok)).toBe(ok);
  });

  test("边文字含特殊字符加引号", () => {
    expect(norm("flowchart TD\n  A -->|调用 (x)| B")).toBe('flowchart TD\n  A -->|"调用 (x)"| B');
  });

  test("行尾 %% 注释去掉，整行注释保留", () => {
    expect(norm("flowchart TD\n  %% 说明\n  A[x] --> B %% 行尾")).toBe("flowchart TD\n  %% 说明\n  A[x] --> B ");
  });

  test("v11 新形状语法与 :::class 不碰", () => {
    const src = 'flowchart TD\n  A@{ shape: doc, label: "文档 (x)" } --> B\n  C["x"]:::hot --> D';
    expect(norm(src)).toBe(src);
  });

  test("Box-->B 里的 x-- 不被当成边", () => {
    const src = "flowchart TD\n  Box-->B[(库 (主))]";
    expect(norm(src)).toBe('flowchart TD\n  Box-->B[("库 (主)")]');
  });

  test("两端带标记的边（x--x / o--o）整段识别，后面的节点照常归一化", () => {
    expect(norm("flowchart TD\n  A x--x B[状态 (有括号)]")).toBe('flowchart TD\n  A x--x B["状态 (有括号)"]');
    expect(norm("flowchart TD\n  A o--o end")).toBe("flowchart TD\n  A o--o End");
    expect(norm("flowchart TD\n  A --> oNode[x (y)]")).toBe('flowchart TD\n  A --> oNode["x (y)"]');
    const ok = "flowchart LR\n  A x--x B\n  C <--> D\n  E -.-> F\n  G ==> H";
    expect(norm(ok)).toBe(ok);
  });

  test("边文字引号里的 | 不当闭合符", () => {
    const src = 'flowchart TD\n  A -->|"a|b"| B';
    expect(norm(src)).toBe(src);
  });

  test("带行尾注释的 subgraph 闭合 end 只去注释", () => {
    expect(norm("flowchart TD\n  subgraph S\n    A --> B\n  end %% close S")).toBe(
      "flowchart TD\n  subgraph S\n    A --> B\n  end",
    );
  });

  test("class 列表逗号后带空格也改名", () => {
    expect(norm("flowchart TD\n  class A, end, C highlight")).toBe("flowchart TD\n  class A, End, C highlight");
  });

  test("label 里的 <!-- 是正文，不当注释删", () => {
    const src = 'flowchart TD\n  A["<!-- 注释范例 -->"] --> B';
    expect(norm(src)).toBe(src);
  });

  test("时序图：全角冒号 → 半角，正文分号 → #59;，已有实体不动", () => {
    expect(norm("sequenceDiagram\n  A->>B： 你好")).toBe("sequenceDiagram\n  A->>B: 你好");
    expect(norm("sequenceDiagram\n  A->>B: init(); start()")).toBe("sequenceDiagram\n  A->>B: init()#59; start()");
    expect(norm("sequenceDiagram\n  Note over A,B： a; b #59; c &amp; d")).toBe(
      "sequenceDiagram\n  Note over A,B: a#59; b #59; c &amp; d",
    );
    const keep = "sequenceDiagram\n  participant A as 用户：前端\n  A->>B: 时间 10：30";
    expect(norm(keep)).toBe(keep);
    idempotent("sequenceDiagram\n  A->>B： x; y");
  });
});

describe("readSvgSize / svgToDataUrl", () => {
  test("数字宽高优先", () => {
    expect(readSvgSize('<svg width="500" height="300px" viewBox="0 0 10 10">')).toEqual({ width: 500, height: 300 });
  });
  test("百分比宽度退回 viewBox", () => {
    expect(readSvgSize('<svg width="100%" viewBox="0 0 640 480">')).toEqual({ width: 640, height: 480 });
  });
  test("只给一边时按 viewBox 比例补齐", () => {
    expect(readSvgSize('<svg width="320" viewBox="0 0 640 480">')).toEqual({ width: 320, height: 240 });
  });
  test("stroke-width 不被当成 width", () => {
    expect(readSvgSize('<svg stroke-width="2" viewBox="0 0 64 48">')).toEqual({ width: 64, height: 48 });
  });
  test("无尺寸信息返回 null", () => {
    expect(readSvgSize("<svg><g/></svg>")).toBeNull();
  });
  test("data URL 编码中文与 #", () => {
    const url = svgToDataUrl('<svg><text fill="#333">中文</text></svg>');
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(url).not.toContain("#");
    expect(decodeURIComponent(url.split(",")[1])).toContain("中文");
  });
});
