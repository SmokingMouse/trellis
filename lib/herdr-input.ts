import type { HerdrSendRefusalCode } from "./herdr-send-guard";

export type HerdrInputDelivery = {
  inputId: string;
  paneId: string;
  /** cancelled：排队中被用户撤回（worker 醒来后跳过，不再发送）。 */
  status: "queued" | "delivered" | "failed" | "cancelled";
  error?: string;
  /**
   * 排队中 / 失败的原文：服务端是排队列表的真源，刷新或换标签页后据此恢复显示，
   * 失败时放回输入框。送达 / 撤回后清掉（不再需要，也不让 fleet 越长越大）。
   */
  text?: string;
  /** 服务端入队时间（ms）。 */
  queuedAt?: number;
  /** failed 且是发前读屏拒发（什么都没打），见 lib/herdr-send-guard.ts。 */
  refusal?: HerdrSendRefusal;
};

export type HerdrSendRefusal = {
  code: HerdrSendRefusalCode;
  /** input_draft：电脑上输入框里现有的字 */
  draft?: string;
  /** 单行草稿：带着它重发（clearDraft）会先清掉再发 */
  clearable?: string;
};
