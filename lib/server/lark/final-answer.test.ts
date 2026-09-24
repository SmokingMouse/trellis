import { describe, expect, mock, test } from "bun:test";
import { isLarkSilent, larkFinalAnswer } from "./final-answer";
import { cardAtToTextAt } from "./protocol";
import { taskLarkPushContent } from "./task-push-policy";

mock.module("server-only", () => ({}));
const { pushTaskRunToLark } = await import("./push");

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
  test("把任务名与状态透传给卡片 header", async () => {
    const calls: Array<{ title?: string; status?: string; textFallback?: string }> = [];
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
          calls.push({ title: args.title, status: args.status, textFallback: args.textFallback });
          return { messageId: "om_1", threadId: null };
        },
        recordOutbox: () => {},
        advanceChat: () => {},
      },
    );
    expect(result).toEqual({ status: "sent", messageId: "om_1" });
    expect(calls).toEqual([{ title: "号池巡检", status: "done", textFallback: "<at id=ou_x></at> 授权掉了" }]);
  });
});
