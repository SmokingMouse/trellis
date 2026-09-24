import { describe, expect, mock, test } from "bun:test";
import { CARD_MAX_BYTES, type FeishuCardV2 } from "./card";
import { isLarkSilent, larkFinalAnswer, parseCardPassthrough } from "./final-answer";
import { cardAtToTextAt } from "./protocol";
import { taskLarkPushContent } from "./task-push-policy";

mock.module("server-only", () => ({}));
const { pushTaskRunToLark } = await import("./push");
const { sendLarkText } = await import("./sdk");

describe("larkFinalAnswer", () => {
  const response = "我先跑一下报告脚本。\n\n结果：号池正常。";
  const finalStart = response.indexOf("结果");

  test("finalStart 缺省或为 0 时整段都是答复", () => {
    expect(larkFinalAnswer({ response, finalStart: null })).toBe(response);
    expect(larkFinalAnswer({ response, finalStart: 0 })).toBe(response);
    expect(larkFinalAnswer({ response })).toBe(response);
  });

  test("只取最后一次中断之后的最终段", () => {
    expect(larkFinalAnswer({ response, finalStart })).toBe("结果：号池正常。");
  });

  test("最终段为空或越界时退回整段，不发空消息", () => {
    expect(larkFinalAnswer({ response: "过程叙述\n\n   ", finalStart: 6 })).toBe("过程叙述\n\n   ");
    expect(larkFinalAnswer({ response, finalStart: response.length })).toBe(response);
  });
});

describe("isLarkSilent", () => {
  test("认首尾空白与包裹反引号", () => {
    expect(isLarkSilent("[SILENT]")).toBe(true);
    expect(isLarkSilent("  `[SILENT]`\n")).toBe(true);
  });

  test("带了别的内容就不是静默", () => {
    expect(isLarkSilent("[SILENT] 今天没事")).toBe(false);
    expect(isLarkSilent("")).toBe(false);
  });
});

describe("parseCardPassthrough", () => {
  const validCard: FeishuCardV2 = {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: "巡检摘要" },
    },
    header: {
      title: { tag: "plain_text", content: "巡检卡片" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "medium",
      elements: [
        { tag: "markdown", content: "巡检正常" },
      ],
    },
  };

  test("裸 JSON 正常解析", () => {
    const raw = JSON.stringify(validCard);
    expect(parseCardPassthrough(raw)).toEqual(validCard);
  });

  test("带首尾空白的裸 JSON 正常解析", () => {
    const raw = `  \n  ${JSON.stringify(validCard)}  \n\t `;
    expect(parseCardPassthrough(raw)).toEqual(validCard);
  });

  test("```json ... ``` 包裹正常解析", () => {
    const raw = `\`\`\`json\n${JSON.stringify(validCard, null, 2)}\n\`\`\``;
    expect(parseCardPassthrough(raw)).toEqual(validCard);
  });

  test("``` ... ``` 包裹（无语言标识）正常解析", () => {
    const raw = `\`\`\`\n${JSON.stringify(validCard)}\n\`\`\``;
    expect(parseCardPassthrough(raw)).toEqual(validCard);
  });

  test("~~~json ... ~~~ 包裹正常解析", () => {
    const raw = `~~~json\n${JSON.stringify(validCard)}\n~~~`;
    expect(parseCardPassthrough(raw)).toEqual(validCard);
  });

  test("非 2.0 schema 返回 null", () => {
    expect(parseCardPassthrough(JSON.stringify({ schema: "1.0", body: { elements: [] } }))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify({ body: { elements: [] } }))).toBeNull();
  });

  test("非对象或顶层数组返回 null", () => {
    expect(parseCardPassthrough(JSON.stringify([validCard]))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify("hello"))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify(12345))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify(null))).toBeNull();
    expect(parseCardPassthrough("")).toBeNull();
    expect(parseCardPassthrough("   ")).toBeNull();
    expect(parseCardPassthrough(null as any)).toBeNull();
    expect(parseCardPassthrough(undefined as any)).toBeNull();
  });

  test("body 为空或 body.elements 不是数组返回 null", () => {
    expect(parseCardPassthrough(JSON.stringify({ schema: "2.0" }))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify({ schema: "2.0", body: null }))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify({ schema: "2.0", body: {} }))).toBeNull();
    expect(parseCardPassthrough(JSON.stringify({ schema: "2.0", body: { elements: "not-array" } }))).toBeNull();
  });

  test("超 24KB 返回 null（走原 markdown 路径）", () => {
    const bigContent = "a".repeat(CARD_MAX_BYTES + 100);
    const bigCard = {
      schema: "2.0",
      body: {
        elements: [{ tag: "markdown", content: bigContent }],
      },
    };
    expect(parseCardPassthrough(JSON.stringify(bigCard))).toBeNull();
  });

  test("普通 markdown 返回 null", () => {
    expect(parseCardPassthrough("# 标题\n\n这是一篇普通的 markdown 报告")).toBeNull();
    expect(parseCardPassthrough("```python\nprint('hello')\n```")).toBeNull();
  });

  test("残缺的 JSON 返回 null", () => {
    expect(parseCardPassthrough('{"schema": "2.0", "body": {')).toBeNull();
  });
});

describe("taskLarkPushContent", () => {
  const base = { taskName: "号池巡检", notifyOn: "error" as const, errorMessage: null };

  test("成功且最终答复为 [SILENT] 时不推", () => {
    expect(taskLarkPushContent({ ...base, status: "done", response: "[SILENT]" })).toBeNull();
  });

  test("成功有内容照推，空答复不推", () => {
    expect(taskLarkPushContent({ ...base, status: "done", response: "🔴 授权掉了" })).toBe("🔴 授权掉了");
    expect(taskLarkPushContent({ ...base, status: "done", response: "  " })).toBeNull();
  });

  test("失败仍按 notify_on 门控", () => {
    expect(taskLarkPushContent({ ...base, status: "error", response: "", errorMessage: "ssh 超时" })).toBe(
      "任务「号池巡检」失败：ssh 超时",
    );
    expect(taskLarkPushContent({ ...base, notifyOn: "never", status: "timeout", response: "" })).toBeNull();
  });
});

describe("cardAtToTextAt", () => {
  test("卡片 id 写法（带不带引号）换成 text 的 user_id 写法", () => {
    expect(cardAtToTextAt("请 <at id=ou_abc></at> 处理")).toBe('请 <at user_id="ou_abc"></at> 处理');
    expect(cardAtToTextAt('<at id="ou_abc">张三</at>')).toBe('<at user_id="ou_abc">张三</at>');
  });

  test("ids 拆成多个、all 补上显示名、email 退成可读前缀", () => {
    expect(cardAtToTextAt("<at ids=ou_a,ou_b></at>")).toBe('<at user_id="ou_a"></at> <at user_id="ou_b"></at>');
    expect(cardAtToTextAt("<at id=all></at>")).toBe('<at user_id="all">所有人</at>');
    expect(cardAtToTextAt("<at email=zhangsan@example.com></at>")).toBe("@zhangsan");
  });

  test("没有 at 标签的文本原样返回", () => {
    expect(cardAtToTextAt("普通 **markdown** <b>不动</b>")).toBe("普通 **markdown** <b>不动</b>");
  });
});

describe("pushTaskRunToLark", () => {
  test("普通 markdown：把任务名与状态透传给卡片 header", async () => {
    const calls: Array<{ title?: string; status?: string; textFallback?: string; card?: FeishuCardV2 }> = [];
    const result = await pushTaskRunToLark(
      {
        botId: "b1",
        chatId: "oc_1",
        sessionId: "s1",
        nodeId: "n1",
        markdown: "<at id=ou_x></at> 授权掉了",
        title: "号池巡检",
        status: "done",
      },
      {
        enabled: () => true,
        publicUrl: () => null,
        getBot: () => ({ appId: "a", appSecret: "s", enabled: true }),
        getChat: () => ({ id: "c1", chatType: "group" }),
        createClient: () => ({}) as never,
        sendText: async (args) => {
          calls.push({ title: args.title, status: args.status, textFallback: args.textFallback, card: args.card });
          return { messageId: "om_1", threadId: null };
        },
        recordOutbox: () => {},
        advanceChat: () => {},
      },
    );
    expect(result).toEqual({ status: "sent", messageId: "om_1" });
    expect(calls).toEqual([
      {
        title: "号池巡检",
        status: "done",
        textFallback: "<at id=ou_x></at> 授权掉了",
        card: undefined,
      },
    ]);
  });

  test("卡片 JSON 直通命中时：传 card，不传 title 与 status，textFallback 优先取 summary.content", async () => {
    const cardJson: FeishuCardV2 = {
      schema: "2.0",
      config: {
        update_multi: true,
        summary: { content: "今日号池全绿" },
      },
      header: {
        title: { tag: "plain_text", content: "日报卡片" },
      },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: "内容" }],
      },
    };

    const calls: Array<{ title?: string; status?: string; textFallback?: string; card?: FeishuCardV2 }> = [];
    const result = await pushTaskRunToLark(
      {
        botId: "b1",
        chatId: "oc_1",
        sessionId: "s1",
        nodeId: "n1",
        markdown: `\`\`\`json\n${JSON.stringify(cardJson, null, 2)}\n\`\`\``,
        title: "号池巡检",
        status: "done",
      },
      {
        enabled: () => true,
        publicUrl: () => null,
        getBot: () => ({ appId: "a", appSecret: "s", enabled: true }),
        getChat: () => ({ id: "c1", chatType: "group" }),
        createClient: () => ({}) as never,
        sendText: async (args) => {
          calls.push({ title: args.title, status: args.status, textFallback: args.textFallback, card: args.card });
          return { messageId: "om_card_1", threadId: null };
        },
        recordOutbox: () => {},
        advanceChat: () => {},
      },
    );

    expect(result).toEqual({ status: "sent", messageId: "om_card_1" });
    expect(calls).toEqual([
      {
        title: undefined,
        status: undefined,
        textFallback: "今日号池全绿",
        card: cardJson,
      },
    ]);
  });

  test("卡片直通无 summary 时降级取 header.title.content", async () => {
    const cardJson: FeishuCardV2 = {
      schema: "2.0",
      config: {
        update_multi: true,
      },
      header: {
        title: { tag: "plain_text", content: "巡检结果标题" },
      },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: "内容" }],
      },
    };

    const calls: Array<{ title?: string; status?: string; textFallback?: string; card?: FeishuCardV2 }> = [];
    await pushTaskRunToLark(
      {
        botId: "b1",
        chatId: "oc_1",
        sessionId: "s1",
        nodeId: "n1",
        markdown: JSON.stringify(cardJson),
        title: "号池巡检",
        status: "done",
      },
      {
        enabled: () => true,
        publicUrl: () => null,
        getBot: () => ({ appId: "a", appSecret: "s", enabled: true }),
        getChat: () => ({ id: "c1", chatType: "group" }),
        createClient: () => ({}) as never,
        sendText: async (args) => {
          calls.push({ title: args.title, status: args.status, textFallback: args.textFallback, card: args.card });
          return { messageId: "om_card_2", threadId: null };
        },
        recordOutbox: () => {},
        advanceChat: () => {},
      },
    );

    expect(calls).toEqual([
      {
        title: undefined,
        status: undefined,
        textFallback: "巡检结果标题",
        card: cardJson,
      },
    ]);
  });

  test("卡片直通既无 summary 也无 header 时降级为「（卡片消息）」", async () => {
    const cardJson: FeishuCardV2 = {
      schema: "2.0",
      config: {
        update_multi: true,
      },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: "内容" }],
      },
    };

    const calls: Array<{ title?: string; status?: string; textFallback?: string; card?: FeishuCardV2 }> = [];
    await pushTaskRunToLark(
      {
        botId: "b1",
        chatId: "oc_1",
        sessionId: "s1",
        nodeId: "n1",
        markdown: JSON.stringify(cardJson),
        title: "号池巡检",
        status: "done",
      },
      {
        enabled: () => true,
        publicUrl: () => null,
        getBot: () => ({ appId: "a", appSecret: "s", enabled: true }),
        getChat: () => ({ id: "c1", chatType: "group" }),
        createClient: () => ({}) as never,
        sendText: async (args) => {
          calls.push({ title: args.title, status: args.status, textFallback: args.textFallback, card: args.card });
          return { messageId: "om_card_3", threadId: null };
        },
        recordOutbox: () => {},
        advanceChat: () => {},
      },
    );

    expect(calls).toEqual([
      {
        title: undefined,
        status: undefined,
        textFallback: "（卡片消息）",
        card: cardJson,
      },
    ]);
  });
});

describe("sendLarkText with card option", () => {
  test("传入 card 时跳过 buildLarkCard 直接以 interactive 发送", async () => {
    const directCard: FeishuCardV2 = {
      schema: "2.0",
      config: { update_multi: true, summary: { content: "直通卡片" } },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: "直通内容" }],
      },
    };

    let sentContent = "";
    let msgType = "";
    const fakeClient = {
      im: {
        v1: {
          message: {
            create: async (params: any) => {
              msgType = params.data.msg_type;
              sentContent = params.data.content;
              return { code: 0, data: { message_id: "om_direct_card" } };
            },
          },
        },
      },
    } as any;

    const res = await sendLarkText({
      client: fakeClient,
      chatId: "oc_test",
      markdown: "原本的 markdown",
      card: directCard,
      mode: "plain",
    });

    expect(res.messageId).toBe("om_direct_card");
    expect(msgType).toBe("interactive");
    expect(JSON.parse(sentContent)).toEqual(directCard);
  });

  test("传入 card 但卡片发送失败时，降级使用 textFallback 发送纯文本", async () => {
    const directCard: FeishuCardV2 = {
      schema: "2.0",
      config: { update_multi: true },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: "卡片内容" }],
      },
    };

    const messagesSent: Array<{ msgType: string; content: string }> = [];
    const fakeClient = {
      im: {
        v1: {
          message: {
            create: async (params: any) => {
              messagesSent.push({ msgType: params.data.msg_type, content: params.data.content });
              if (params.data.msg_type === "interactive") {
                return { code: 99999, msg: "Card validation error" };
              }
              return { code: 0, data: { message_id: "om_text_fallback" } };
            },
          },
        },
      },
    } as any;

    const res = await sendLarkText({
      client: fakeClient,
      chatId: "oc_test",
      markdown: JSON.stringify(directCard),
      card: directCard,
      textFallback: "<at id=ou_123></at> 卡片降级回退",
      mode: "plain",
    });

    expect(res.messageId).toBe("om_text_fallback");
    expect(messagesSent).toHaveLength(2);
    expect(messagesSent[0].msgType).toBe("interactive");
    expect(messagesSent[1].msgType).toBe("text");
    expect(JSON.parse(messagesSent[1].content)).toEqual({
      text: '<at user_id="ou_123"></at> 卡片降级回退',
    });
  });
});

