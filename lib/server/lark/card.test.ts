import { describe, expect, test, mock } from "bun:test";
import {
  buildLarkCard,
  optimizeMarkdownStyle,
  splitIntoBodySections,
  truncateMarkdown,
  SECTION_SOFT_LIMIT,
  SECTION_HARD_LIMIT,
  MAX_SECTIONS,
  EMPTY_TEXT_FALLBACK,
} from "./card";

mock.module("server-only", () => ({}));
const { sendLarkText, uploadLarkImage } = await import("./sdk");

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
    test("超长文本在代码块中截断时，不切坏代码块围栏，尾部带「详情见 Trellis 会话」链接", async () => {
      // 构造包含超长代码块的 markdown 文本（> SECTION_HARD_LIMIT = 4000）
      const longLines = Array.from(
        { length: 300 },
        (_, i) => `  const value_${i} = computeHash("entry_${i}_payload_data");`,
      );
      const longMarkdown = [
        "# 超长代码示例",
        "```typescript",
        "function handleLongExecution() {",
        ...longLines,
        "}",
        "```",
      ].join("\n");

      expect(longMarkdown.length).toBeGreaterThan(SECTION_HARD_LIMIT);

      const sessionUrl = "https://trellis.example.com/?session=s1&node=n2";
      const card = await buildLarkCard(longMarkdown, { sessionUrl });

      expect(card.schema).toBe("2.0");
      expect(card.body.elements.length).toBeLessThanOrEqual(MAX_SECTIONS);

      const lastElement = card.body.elements[card.body.elements.length - 1];
      expect(lastElement.tag).toBe("markdown");

      const content = String(lastElement.content);
      // 必须包含「详情见 Trellis 会话」链接
      expect(content).toContain(`[详情见 Trellis 会话](${sessionUrl})`);
      expect(content).toContain("…（内容已截断，");

      // 验证围栏平衡：检查开闭 ``` 数量
      const matches = content.match(/```/g);
      // 如果代码块被截断，应有开有闭（成对出现，保证围栏不坏）
      if (matches) {
        expect(matches.length % 2).toBe(0);
      }

      // 截断提示链接必须在代码块闭合之后，而不是被代码块包裹吞噬
      const lastCodeFenceIndex = content.lastIndexOf("```");
      const linkIndex = content.indexOf("[详情见 Trellis 会话]");
      expect(linkIndex).toBeGreaterThan(lastCodeFenceIndex);
    });

    test("超长多段落文本不超过 MAX_SECTIONS，尾部带默认 Trellis 会话链接", async () => {
      const paragraphs = Array.from(
        { length: 8 },
        (_, i) => `段落 ${i + 1}：` + "超长分析内容描述。".repeat(300),
      );
      const longText = paragraphs.join("\n\n");

      const card = await buildLarkCard(longText);
      expect(card.body.elements.length).toBeLessThanOrEqual(MAX_SECTIONS);

      const lastElement = card.body.elements[card.body.elements.length - 1];
      const content = String(lastElement.content);
      expect(content).toContain("[详情见 Trellis 会话]");
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

      // 没有 img 元素，退化为文本
      const imgElements = elements.filter((e) => e.tag === "img");
      expect(imgElements).toHaveLength(0);

      // 文本中包含退化的「[图片] alt: link」
      const fullText = elements.map((e) => e.content).join("\n");
      expect(fullText).toContain("[图片] 错误图片演示: https://example.com/images/fail.png");
      expect(fullText).toContain("前置文字说明");
      expect(fullText).toContain("后置文字说明");
    });

    test("本机绝对路径图片与无 alt 图片支持", async () => {
      const markdown = "![](/tmp/chart.png)";
      const mockUpload = async (src: string) => {
        expect(src).toBe("/tmp/chart.png");
        return "img_v3_chart_key";
      };

      const card = await buildLarkCard(markdown, { uploadImage: mockUpload });
      expect(card.body.elements).toHaveLength(1);
      expect(card.body.elements[0].tag).toBe("img");
      expect(card.body.elements[0].img_key).toBe("img_v3_chart_key");
      expect(card.body.elements[0].alt).toEqual({ tag: "plain_text", content: "" });
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

  describe("5. 可选 Header 与状态主题", () => {
    test("传入 title 与 status 时生成对应 header", async () => {
      const card = await buildLarkCard("完成任务", {
        title: "执行报告",
        status: "error",
      });

      expect(card.header).toBeDefined();
      expect(card.header!.title).toEqual({ tag: "plain_text", content: "执行报告" });
      expect(card.header!.template).toBe("red");
    });
  });

  describe("6. sdk.ts: 互动卡片发送、thread 语义与降级路径", () => {
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
                  // 模拟飞书校验卡片失败
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
      // 确认先尝试了 interactive，失败后降级调用了 text
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
