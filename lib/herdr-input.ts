export type HerdrInputDelivery = {
  inputId: string;
  paneId: string;
  status: "queued" | "delivered" | "failed";
  error?: string;
};
