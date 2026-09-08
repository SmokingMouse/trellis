import type { AttachResult, ServerNotification } from "@smokingmouse/agent-server/protocol";

export type ThreadEvent =
  | { type: "snapshot"; snapshot: AttachResult }
  | { type: "notification"; notification: ServerNotification }
  | { type: "connection"; state: string };
