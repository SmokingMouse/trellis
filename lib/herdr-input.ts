export type HerdrInputDelivery = {
  inputId: string;
  paneId: string;
  /** cancelled：排队中被用户撤回（worker 醒来后跳过，不再发送）。 */
  status: "queued" | "delivered" | "failed" | "cancelled";
  error?: string;
};
