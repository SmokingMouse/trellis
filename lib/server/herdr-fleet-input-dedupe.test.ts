import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { HerdrInputDelivery } from "../herdr-input";

mock.module("server-only", () => ({}));

const { HerdrFleetService } = await import("./herdr-fleet");
const { HerdrSendRefusedError } = await import("./herdr-client");

/** 只实现 input 路径用到的那几样的假 client。 */
function stubClient(enqueue: (text: string) => Promise<HerdrInputDelivery>) {
  const client = {
    inputDeliveries: [] as HerdrInputDelivery[],
    calls: [] as string[],
    subscribe: () => () => {},
    stop: () => {},
    enqueueInput: (_paneId: string, text: string) => {
      client.calls.push(text);
      return enqueue(text);
    },
  };
  return client;
}

function service(client: ReturnType<typeof stubClient>) {
  return new HerdrFleetService(client as never, { db: new Database(":memory:") });
}

describe("HerdrFleetService.input 按 client_msg_id 去重", () => {
  test("同一个 id 重发：不再打字，回第一次的回执（换成它此刻的状态）", async () => {
    const client = stubClient(async () => ({ inputId: "i1", paneId: "p", status: "queued", text: "hi" }));
    const fleet = service(client);
    expect((await fleet.input("p", "hi", undefined, "m-1")).status).toBe("queued");
    client.inputDeliveries = [{ inputId: "i1", paneId: "p", status: "delivered" }];
    expect(await fleet.input("p", "hi", undefined, "m-1")).toEqual({ inputId: "i1", paneId: "p", status: "delivered" });
    expect(client.calls).toEqual(["hi"]);
  });

  test("不同 id / 不带 id：各发各的", async () => {
    let n = 0;
    const client = stubClient(async () => ({ inputId: `i${++n}`, paneId: "p", status: "delivered" }));
    const fleet = service(client);
    await fleet.input("p", "a", undefined, "m-1");
    await fleet.input("p", "a", undefined, "m-2");
    await fleet.input("p", "a");
    await fleet.input("p", "a");
    expect(client.calls).toHaveLength(4);
  });

  test("第一次被读屏拒发（什么都没打）→ 重发真的再试", async () => {
    let refuse = true;
    const client = stubClient(async () => {
      if (refuse) throw new HerdrSendRefusedError({ code: "dialog_open" });
      return { inputId: "i2", paneId: "p", status: "delivered" };
    });
    const fleet = service(client);
    await expect(fleet.input("p", "hi", undefined, "m-1")).rejects.toMatchObject({ code: "dialog_open" });
    await Promise.resolve();
    refuse = false;
    expect((await fleet.input("p", "hi", undefined, "m-1")).status).toBe("delivered");
    expect(client.calls).toHaveLength(2);
  });

  test("排队后送达前被拒发 → 重发时重新排队", async () => {
    let n = 0;
    const client = stubClient(async () => ({ inputId: `i${++n}`, paneId: "p", status: "queued" }));
    const fleet = service(client);
    await fleet.input("p", "hi", undefined, "m-1");
    client.inputDeliveries = [{ inputId: "i1", paneId: "p", status: "failed", refusal: { code: "input_draft" } }];
    expect((await fleet.input("p", "hi", undefined, "m-1")).inputId).toBe("i2");
    expect(client.calls).toHaveLength(2);
  });

  test("其余失败（可能已经打了一半）→ TTL 内回同一个错，不再打", async () => {
    const client = stubClient(async () => {
      throw new Error("socket timeout");
    });
    const fleet = service(client);
    await expect(fleet.input("p", "hi", undefined, "m-1")).rejects.toThrow("socket timeout");
    await expect(fleet.input("p", "hi", undefined, "m-1")).rejects.toThrow("socket timeout");
    expect(client.calls).toHaveLength(1);
  });
});
