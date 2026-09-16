import { describe, expect, test, mock } from "bun:test";
import * as os from "node:os";
import { promises as fsP } from "node:fs";
import * as path from "node:path";
import {
  buildLarkCard,
  optimizeMarkdownStyle,
  splitIntoBodySections,
  truncateMarkdown,
  stripInvalidImageKeys,
  nextMarkdownFence,
  CARD_MAX_BYTES,
  SECTION_SOFT_LIMIT,
  SECTION_HARD_LIMIT,
  MAX_SECTIONS,
  EMPTY_TEXT_FALLBACK,
} from "./card";

mock.module("server-only", () => ({}));
const { sendLarkText, uploadLarkImage, isPrivateOrLoopbackHost } = await import("./sdk");
const { pushTaskRunToLark, taskLarkMarkdown } = await import("./push");

function bytes(o: unknown): number {
  return Buffer.byteLength(JSON.stringify(o), "utf8");
}

function fenceBalanced(s: string): boolean {
  const t = (s.match(/^```/gm) || []).length;
  const w = (s.match(/^~~~/gm) || []).length;
  return t % 2 === 0 && w % 2 === 0;
}

describe("Lark Interactive Card Schema 2.0 Builder", () => {
  describe("1. Markdown 方言优化与卡片形状", () => {
    test("标题 (Headings): H1 降为 H4，H2~H6 降为 H5，相邻标题间距优化", async () => {
      const markdown = "# 一级标题\n## 二级标题\n### 三级标题\n正文内容";
      const card = await buildLarkCard(markdown);

      expect(card.schema).toBe("2.0");
      expect(card.config.update_multi).toBe(true);
      expect(card.config.width_mode).toBe("fill");
      expect(card.config.enable_forward).toBe(true);
      expect(card.body.direction).toBe("vertical");
      expect(card.body.vertical_spacing).toBe("medium");

      const elements = card.body.elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      const first = elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("#### 一级标题");
      expect(content).toContain("##### 二级标题");
      expect(content).toContain("##### 三级标题");
      expect(content).toContain("<br>");
      expect(content).toContain("正文内容");
    });

    test("有序列表与无序列表 (Lists): 正常渲染在 markdown 元素中", async () => {
      const markdown = "1. 第一项\n2. 第二项\n3. 第三项\n\n- 无序项 A\n- 无序项 B";
      const card = await buildLarkCard(markdown);

      expect(card.schema).toBe("2.0");
      const first = card.body.elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("1. 第一项");
      expect(content).toContain("2. 第二项");
      expect(content).toContain("3. 第三项");
      expect(content).toContain("- 无序项 A");
      expect(content).toContain("- 无序项 B");
    });

    test("行内代码 (Inline Code): 反引号代码正常保留", async () => {
      const markdown = "请运行 `bun test` 检查结果，或设置 `NODE_ENV=production`。";
      const card = await buildLarkCard(markdown);

      expect(card.schema).toBe("2.0");
      const first = card.body.elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("`bun test`");
      expect(content).toContain("`NODE_ENV=production`");
    });

    test("围栏代码块 (Fenced Code Block): 保护内容不被破坏，包括 $1, $& 特殊字符", async () => {
      const markdown = [
        "开始分析代码：",
        "```typescript",
        "function replacePattern(text: string): string {",
        '  const regex = /pattern/g;',
        '  return text.replace(regex, "$& $1 $\' $`");',
        "}",
        "```",
        "分析结束。",
      ].join("\n");

      const card = await buildLarkCard(markdown);
      expect(card.schema).toBe("2.0");

      const first = card.body.elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("```typescript");
      expect(content).toContain('return text.replace(regex, "$& $1 $\' $`");');
      expect(content).toContain("```");
      expect(content).toContain("<br>");
      expect(content).not.toContain("___TRELLIS_CB_");
    });

    test("表格 (Table): 自动注入 <br> 边距优化排版", async () => {
      const markdown = [
        "前置描述信息",
        "| 接口 | 方法 | 描述 |",
        "|---|---|---|",
        "| /api/lark | POST | 飞书推送 |",
        "| /api/session | GET | 获取会话 |",
        "后置描述信息",
      ].join("\n");

      const card = await buildLarkCard(markdown);
      expect(card.schema).toBe("2.0");

      const first = card.body.elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("| 接口 | 方法 | 描述 |");
      expect(content).toContain("| /api/lark | POST | 飞书推送 |");
      expect(content).toContain("<br>");
    });

    test("链接 (Links): 标准 markdown 链接保留", async () => {
      const markdown = "查看项目进展，请访问 [Trellis 官网](https://github.com/trellis/trellis)。";
      const card = await buildLarkCard(markdown);

      expect(card.schema).toBe("2.0");
      const first = card.body.elements[0];
      expect(first.tag).toBe("markdown");

      const content = String(first.content);
      expect(content).toContain("[Trellis 官网](https://github.com/trellis/trellis)");
    });
  });

  describe("2. 超长文本截断与代码块围栏保护", () => {
    test("超长代码块撑破 24KB 预算被截断时，不切坏围栏，尾部带「详情见 Trellis 会话」链接", async () => {
      const longLines = Array.from(
        { length: 650 },
        (_, i) => `  const value_${i} = computeHash("entry_${i}_payload_data_long_string");`,
      );
      const longMarkdown = [
        "# 超长代码示例",
        "```typescript",
        "function handleLongExecution() {",
        ...longLines,
        "}",
        "```",
      ].join("\n");

      const sessionUrl = "https://trellis.example.com/?session=s1&node=n2";
      const card = await buildLarkCard(longMarkdown, { sessionUrl });

      expect(card.schema).toBe("2.0");
      expect(bytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES);

      const lastElement = card.body.elements[card.body.elements.length - 1];
      expect(lastElement.tag).toBe("markdown");

      const content = String(lastElement.content);
      expect(content).toContain(`[详情见 Trellis 会话](${sessionUrl})`);
      expect(content).toContain("…（内容已截断，");

      // 验证围栏平衡
      expect(fenceBalanced(content)).toBe(true);

      // 截断提示链接必须在代码块闭合之后
      const lastCodeFenceIndex = content.lastIndexOf("```");
      const linkIndex = content.indexOf("[详情见 Trellis 会话]");
      expect(linkIndex).toBeGreaterThan(lastCodeFenceIndex);
    });

    test("超长多段落文本不超过 MAX_SECTIONS，尾部带 Trellis 会话链接（有 sessionUrl 时）", async () => {
      const paragraphs = Array.from(
        { length: 8 },
        (_, i) => `段落 ${i + 1}：` + "超长分析内容描述。".repeat(300),
      );
      const longText = paragraphs.join("\n\n");
      const sessionUrl = "https://trellis.example.com/?session=s1";

      const card = await buildLarkCard(longText, { sessionUrl });
      expect(card.body.elements.length).toBeLessThanOrEqual(MAX_SECTIONS);
      expect(bytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES);

      const lastElement = card.body.elements[card.body.elements.length - 1];
      const content = String(lastElement.content);
      expect(content).toContain(`[详情见 Trellis 会话](${sessionUrl})`);
    });
  });

  describe("3. 图片处理：上传成功与失败桩", () => {
    test("上传成功桩：替换为 img 元素，支持大图预览，其余 markdown 分段发送", async () => {
      const markdown = [
        "架构分析如下：",
        "![系统拓扑图](https://example.com/images/topo.png)",
        "上述架构运行正常。",
      ].join("\n\n");

      const uploadedSources: string[] = [];
      const mockUpload = async (src: string) => {
        uploadedSources.push(src);
        return "img_v3_mock_topo_key_123";
      };

      const card = await buildLarkCard(markdown, { uploadImage: mockUpload });
      expect(uploadedSources).toEqual(["https://example.com/images/topo.png"]);

      const elements = card.body.elements;
      expect(elements).toHaveLength(3);

      // 第 1 段：前置 markdown
      expect(elements[0].tag).toBe("markdown");
      expect(elements[0].content).toContain("架构分析如下：");

      // 第 2 段：img 元素
      expect(elements[1].tag).toBe("img");
      expect(elements[1].img_key).toBe("img_v3_mock_topo_key_123");
      expect(elements[1].alt).toEqual({ tag: "plain_text", content: "系统拓扑图" });
      expect(elements[1].mode).toBe("fit_horizontal");
      expect(elements[1].preview).toBe(true);

      // 第 3 段：后置 markdown
      expect(elements[2].tag).toBe("markdown");
      expect(elements[2].content).toContain("上述架构运行正常。");
    });

    test("上传失败桩：退化为文字「[图片] alt」+ 链接，其余内容照常发送", async () => {
      const markdown = [
        "前置文字说明",
        "![错误图片演示](https://example.com/images/fail.png)",
        "后置文字说明",
      ].join("\n\n");

      const failingUpload = async () => {
        throw new Error("500 Internal Server Error");
      };

      const card = await buildLarkCard(markdown, { uploadImage: failingUpload });
      const elements = card.body.elements;

      const imgElements = elements.filter((e) => e.tag === "img");
      expect(imgElements).toHaveLength(0);

      const fullText = elements.map((e) => e.content).join("\n");
      expect(fullText).toContain("[图片] 错误图片演示: https://example.com/images/fail.png");
      expect(fullText).toContain("前置文字说明");
      expect(fullText).toContain("后置文字说明");
    });

    test("代码块内的图片语法不应被提取为图片元素", async () => {
      const markdown = [
        "以下是 Markdown 语法示例：",
        "```markdown",
        "![示例图](https://example.com/demo.png)",
        "```",
        "请勿直接渲染为真实图片。",
      ].join("\n");

      let uploadCalled = false;
      const card = await buildLarkCard(markdown, {
        uploadImage: async () => {
          uploadCalled = true;
          return "img_should_not_upload";
        },
      });

      expect(uploadCalled).toBe(false);
      const imgElements = card.body.elements.filter((e) => e.tag === "img");
      expect(imgElements).toHaveLength(0);
      expect(card.body.elements[0].content).toContain("![示例图](https://example.com/demo.png)");
    });
  });

  describe("4. 空文本处理", () => {
    test("空文本/空白字符返回「（Agent 未返回文本）」", async () => {
      const emptyInputs = ["", "   ", "\n\n\t  \n"];
      for (const input of emptyInputs) {
        const card = await buildLarkCard(input);
        expect(card.schema).toBe("2.0");
        expect(card.body.elements).toEqual([
          {
            tag: "markdown",
            content: EMPTY_TEXT_FALLBACK,
          },
        ]);
      }
    });
  });

  describe("5. 可选 Header 与状态主题 (M4)", () => {
    test("传入 title 与 status 时生成对应 header，且默认生成 60 字符 summary", async () => {
      const longText = "这是一段非常详细的 Agent 分析报告正文内容。".repeat(10);
      const card = await buildLarkCard(longText, {
        title: "执行报告",
        status: "error",
      });

      expect(card.header).toBeDefined();
      expect(card.header!.title).toEqual({ tag: "plain_text", content: "执行报告" });
      expect(card.header!.template).toBe("red");
      expect(card.config.summary).toBeDefined();
      expect(card.config.summary!.content.length).toBeLessThanOrEqual(60);
      expect(card.config.summary!.content).toBe(longText.slice(0, 60));
    });

    test("未传入 title 时无 header", async () => {
      const card = await buildLarkCard("正文内容", { status: "error" });
      expect(card.header).toBeUndefined();
    });
  });

  describe("6. M1: 长度预算改按 UTF-8 字节 <= 24KB", () => {
    test("15886 个中文字符输入 -> 卡片 JSON 字节 <= 24KB 且尾链在", async () => {
      const sessionUrl = "https://trellis.example.com/?session=s1&node=n1";
      // 8 段，每段 ~2000 字符，总计 ~16000 字符
      const md = Array.from(
        { length: 8 },
        (_, i) => `段落${i}：` + "中文压测内容反复出现。".repeat(180),
      ).join("\n\n");

      expect(md.length).toBeGreaterThanOrEqual(15886);
      const card = await buildLarkCard(md, { sessionUrl });
      const totalBytes = bytes(card);

      expect(totalBytes).toBeLessThanOrEqual(CARD_MAX_BYTES);
      expect(totalBytes).toBeLessThanOrEqual(24 * 1024);

      const lastElem = card.body.elements[card.body.elements.length - 1];
      expect(lastElem.tag).toBe("markdown");
      expect(String(lastElem.content)).toContain(`[详情见 Trellis 会话](${sessionUrl})`);
    });
  });

  describe("7. M2: stripInvalidImageKeys 剔除非 img_ 图片引用 (CardKit 200570)", () => {
    test("带 title、含空格 URL、尖括号 URL 的图片均被清洗，不残留非 img_ 图片语法", async () => {
      const cases = [
        '![标题图](https://e.com/a.png "图注")',
        "![空格图](https://e.com/a b.png)",
        "![尖括号](<https://e.com/a.png>)",
      ];
      for (const md of cases) {
        const card = await buildLarkCard(md, { uploadImage: async () => "img_k" });
        const txt = card.body.elements.map((e: any) => e.content ?? "").join("\n");
        const leaked = /!\[[^\]]*\]\((?!img_)/.test(txt);
        expect(leaked).toBe(false);
      }
    });

    test("代码块内的图片语法受占位符保护，不被 strip 误伤", () => {
      const md = "```markdown\n![example](https://foo.bar/pic.png)\n```";
      const optimized = optimizeMarkdownStyle(md);
      expect(optimized).toContain("![example](https://foo.bar/pic.png)");
    });
  });

  describe("8. M3: 图片来源收紧与本地路径白名单", () => {
    test("私网/环回地址过滤识别", () => {
      expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
      expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
      expect(isPrivateOrLoopbackHost("172.31.255.255")).toBe(true);
      expect(isPrivateOrLoopbackHost("192.168.1.1")).toBe(true);
      expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
      expect(isPrivateOrLoopbackHost("::1")).toBe(true);
      expect(isPrivateOrLoopbackHost("example.com")).toBe(false);
      expect(isPrivateOrLoopbackHost("github.com")).toBe(false);
    });

    test("/tmp 文件、http:// 明文、169.254 地址、超时桩 四种均被拦截且正文照发", async () => {
      let uploadCalls = 0;
      const fakeClient = {
        im: {
          v1: {
            image: {
              create: async () => {
                uploadCalls++;
                return { code: 0, image_key: "img_test" };
              },
            },
          },
        },
      } as any;

      // 1. /tmp 文件不在白名单
      const resTmp = await uploadLarkImage({ client: fakeClient, image: "/tmp/secret.txt" });
      expect(resTmp).toBe("");

      // 2. http:// 明文被拒绝
      const resHttp = await uploadLarkImage({ client: fakeClient, image: "http://example.com/pic.png" });
      expect(resHttp).toBe("");

      // 3. 169.254 link-local SSRF 被拒绝
      const resSsrf = await uploadLarkImage({ client: fakeClient, image: "https://169.254.169.254/latest/meta-data/" });
      expect(resSsrf).toBe("");

      // 4. 超时桩
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as unknown as typeof fetch;
      try {
        const resTimeout = await uploadLarkImage({ client: fakeClient, image: "https://example.com/slow.png" });
        expect(resTimeout).toBe("");
      } finally {
        globalThis.fetch = origFetch;
      }

      expect(uploadCalls).toBe(0);

      // 正文照发验证：经 buildLarkCard 降级为文本，正文不丢
      const card = await buildLarkCard(
        "正文开头\n\n![tmp](/tmp/secret.txt)\n\n![http](http://example.com/pic.png)\n\n正文结尾",
        {
          uploadImage: (src) => uploadLarkImage({ client: fakeClient, image: src }),
        },
      );
      const fullText = card.body.elements.map((e: any) => e.content ?? "").join("\n");
      expect(fullText).toContain("正文开头");
      expect(fullText).toContain("正文结尾");
      expect(fullText).toContain("[图片] tmp: /tmp/secret.txt");
      expect(fullText).toContain("[图片] http: http://example.com/pic.png");
      expect(card.body.elements.filter((e: any) => e.tag === "img")).toHaveLength(0);
    });

    test("允许 ~/.trellis/ 与 workspacePath 内的本地图片", async () => {
      let uploaded: Buffer | null = null;
      const fakeClient = {
        im: {
          v1: {
            image: {
              create: async (p: any) => {
                uploaded = p.data.image;
                return { code: 0, image_key: "img_valid_local" };
              },
            },
          },
        },
      } as any;

      const tmpDir = os.tmpdir();
      const testWorkspace = path.join(tmpDir, "trellis-test-ws-" + Math.random().toString(36).slice(2));
      await Bun.write(path.join(testWorkspace, "diagram.png"), "FAKE_PNG_BYTES");

      const key = await uploadLarkImage({
        client: fakeClient,
        image: path.join(testWorkspace, "diagram.png"),
        workspacePath: testWorkspace,
      });

      expect(key).toBe("img_valid_local");
      expect(uploaded ? Buffer.from(uploaded as any).toString() : "").toBe("FAKE_PNG_BYTES");
    });

    test("workspace 内指向外部的 symlink 被拒（realpath 后再比对白名单）", async () => {
      let uploadCalls = 0;
      const fakeClient = {
        im: { v1: { image: { create: async () => { uploadCalls++; return { code: 0, image_key: "img_leak" }; } } } },
      } as any;
      const tmpDir = os.tmpdir();
      const outside = path.join(tmpDir, "trellis-test-outside-" + Math.random().toString(36).slice(2));
      const ws = path.join(tmpDir, "trellis-test-ws-" + Math.random().toString(36).slice(2));
      await Bun.write(path.join(outside, "secret.txt"), "SECRET_TOKEN_ABC123");
      await fsP.mkdir(ws, { recursive: true });
      await fsP.symlink(path.join(outside, "secret.txt"), path.join(ws, "leak.png"));

      const key = await uploadLarkImage({ client: fakeClient, image: path.join(ws, "leak.png"), workspacePath: ws });
      expect(key).toBe("");
      expect(uploadCalls).toBe(0);
    });

    test("大写 HTTPS:// 按 URL 处理，不落到本机路径分支", async () => {
      const origFetch = globalThis.fetch;
      let fetched = 0;
      globalThis.fetch = (async () => {
        fetched++;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      }) as any;
      try {
        const fakeClient = {
          im: { v1: { image: { create: async () => ({ code: 0, image_key: "img_upper" }) } } },
        } as any;
        const key = await uploadLarkImage({ client: fakeClient, image: "HTTPS://example.com/a.png" });
        expect(fetched).toBe(1);
        expect(key).toBe("img_upper");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("9. M5: push.ts 定时任务推送与 dual truncation 解耦", () => {
    test("卡片路径传入完整原文，textFallback 采用 taskLarkMarkdown", async () => {
      const calls: Array<{ msgType: string; markdown: string; textFallback?: string }> = [];
      const fakeClient = {
        im: {
          v1: {
            message: {
              create: async (a: any) => ({ code: 0, data: { message_id: "om_push_test" } }),
            },
          },
        },
      } as any;

      const longMd = "这是定时任务长分析报告内容。".repeat(500); // ~7000 字
      const res = await pushTaskRunToLark(
        { botId: "b1", chatId: "oc_1", sessionId: "s1", nodeId: "n1", markdown: longMd },
        {
          enabled: () => true,
          publicUrl: () => "https://trellis.example.com",
          getBot: () => ({ appId: "a", appSecret: "s", enabled: true }),
          getChat: () => ({ id: "row1", chatType: "group" }),
          createClient: () => fakeClient,
          sendText: async (args) => {
            calls.push({
              msgType: "interactive",
              markdown: args.markdown,
              textFallback: args.textFallback,
            });
            return { messageId: "om_push_test", threadId: null };
          },
          recordOutbox: () => {},
          advanceChat: () => {},
        },
      );

      expect(res.status).toBe("sent");
      expect(calls).toHaveLength(1);
      // 卡片路径收到完整原文
      expect(calls[0].markdown).toBe(longMd);
      // 纯文本 fallback 经过 4000 字截断
      expect(calls[0].textFallback).toBeDefined();
      expect(calls[0].textFallback!.length).toBeLessThanOrEqual(4000);
      expect(calls[0].textFallback!).toContain("…（内容已截断，完整内容见 Trellis：https://trellis.example.com/?session=s1&node=n1）");
    });
  });

  describe("10. M6: 占位符带随机 nonce 防正文碰撞 (P8 fixture)", () => {
    test("正文含既有占位符 ___TRELLIS_CB_0___ 时不导致代码块错位", async () => {
      const md = "用户正文含占位符 ___TRELLIS_CB_0___ 请注意\n\n```ts\nconst a = 1;\n```";
      const card = await buildLarkCard(md);
      const txt = card.body.elements.map((e: any) => String(e.content)).join("\n");

      expect(txt).toContain("用户正文含占位符 ___TRELLIS_CB_0___ 请注意");
      expect(txt).toContain("const a = 1;");
      // 代码块没有被搬移到用户假占位符位置
      const fakePlaceholderIdx = txt.indexOf("用户正文含占位符 ___TRELLIS_CB_0___");
      const codeIdx = txt.indexOf("const a = 1;");
      expect(codeIdx).toBeGreaterThan(fakePlaceholderIdx);
    });
  });

  describe("11. Minor 优化与边界防护 (m1–m10)", () => {
    test("m1: truncateMarkdown 严格不超 maxLen 且围栏平衡", () => {
      for (const maxLen of [4000, 200, 60, 40]) {
        const r = truncateMarkdown("```ts\n" + "x".repeat(20000), maxLen, "https://t.example/?session=s&node=n");
        expect(r.length).toBeLessThanOrEqual(maxLen);
        expect(fenceBalanced(r)).toBe(true);
      }
    });

    test("m8: nextMarkdownFence 对单行 ``` inline ``` 不误判为未闭合围栏", () => {
      const fence = nextMarkdownFence("这是一行行内代码：``` inline ``` 正常文本", null);
      expect(fence).toBeNull();
      const f1 = nextMarkdownFence("```ts", null);
      expect(f1).not.toBeNull();
      const f2 = nextMarkdownFence("```", f1);
      expect(f2).toBeNull();
    });

    test("m9: 代码块内的一级标题 # comment 不误触发全文标题降级", async () => {
      const md = "```python\n# This is a comment\nx = 1\n```\n\n正文的一级标题：\n# 真实标题";
      const card = await buildLarkCard(md);
      const content = String(card.body.elements[0].content);
      // 真实标题依然降级为 H4
      expect(content).toContain("#### 真实标题");
      // 代码块内的 # This is a comment 保持原样，不变成 ####
      expect(content).toContain("# This is a comment");
    });

    test("m10: 无 sessionUrl 时截断不渲染无意义的相对路径链接", () => {
      const truncated = truncateMarkdown("a".repeat(10000), 100);
      expect(truncated).not.toContain("[详情见 Trellis 会话]");
      expect(truncated).toContain("…（内容已截断）");
    });
  });

  describe("12. sdk.ts: 互动卡片发送、thread 语义与降级路径", () => {
    test("正常发送走 msg_type interactive 互动卡片", async () => {
      let replyPayload: unknown = null;
      const fakeClient = {
        im: {
          v1: {
            message: {
              reply: async (args: { path: { message_id: string }; data: unknown }) => {
                replyPayload = args.data;
                return { code: 0, data: { message_id: "om_card_123", thread_id: "ot_card_123" } };
              },
            },
            image: {
              create: async () => ({ image_key: "img_test" }),
            },
          },
        },
      } as any;

      const sent = await sendLarkText({
        client: fakeClient,
        chatId: "oc_test_chat",
        replyToMessageId: "om_inbound_msg",
        markdown: "# 结果\n成功执行",
        mode: "thread",
      });

      expect(sent.messageId).toBe("om_card_123");
      expect(sent.threadId).toBe("ot_card_123");
      expect(replyPayload).toMatchObject({
        msg_type: "interactive",
        reply_in_thread: true,
      });
      const parsedCard = JSON.parse((replyPayload as any).content);
      expect(parsedCard.schema).toBe("2.0");
    });

    test("卡片发送失败（非 0 code）自动降级为 text 纯文本", async () => {
      const calls: Array<{ msgType: string; content: string }> = [];

      const fakeClient = {
        im: {
          v1: {
            message: {
              reply: async (args: { path: { message_id: string }; data: { msg_type: string; content: string } }) => {
                calls.push({ msgType: args.data.msg_type, content: args.data.content });
                if (args.data.msg_type === "interactive") {
                  return { code: 230001, msg: "Card validation failed" };
                }
                return { code: 0, data: { message_id: "om_text_fallback", thread_id: null } };
              },
              create: async (args: { data: { msg_type: string; content: string } }) => {
                calls.push({ msgType: args.data.msg_type, content: args.data.content });
                if (args.data.msg_type === "interactive") {
                  return { code: 230001, msg: "Card validation failed" };
                }
                return { code: 0, data: { message_id: "om_text_fallback", thread_id: null } };
              },
            },
            image: {
              create: async () => ({ image_key: "img_test" }),
            },
          },
        },
      } as any;

      const sent = await sendLarkText({
        client: fakeClient,
        chatId: "oc_test_chat",
        replyToMessageId: "om_inbound_msg",
        markdown: "测试降级消息",
      });

      expect(sent.messageId).toBe("om_text_fallback");
      expect(calls.some((c) => c.msgType === "interactive")).toBe(true);
      expect(calls.some((c) => c.msgType === "text")).toBe(true);
      const textCall = calls.find((c) => c.msgType === "text");
      expect(JSON.parse(textCall!.content)).toEqual({ text: "测试降级消息" });
    });

    test("uploadLarkImage 上传 Buffer 获取 image_key", async () => {
      let uploadedBuffer: Buffer | null = null;
      const fakeClient = {
        im: {
          v1: {
            image: {
              create: async (payload: { data: { image: Buffer; image_type: string } }) => {
                uploadedBuffer = payload.data.image;
                return { code: 0, image_key: "img_v3_uploaded_key" };
              },
            },
          },
        },
      } as any;

      const buffer = Buffer.from("fake-png-binary-data");
      const key = await uploadLarkImage({ client: fakeClient, image: buffer });
      expect(key).toBe("img_v3_uploaded_key");
      expect(uploadedBuffer as unknown).toEqual(buffer);
    });
  });
});
