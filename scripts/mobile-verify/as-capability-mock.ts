import type { AgentServer } from "@smokingmouse/agent-server";
import type { JsonObject } from "@smokingmouse/agent-server/protocol";

/** Simulate an older daemon's actual initialize response on the Unix wire. */
export function omitMidThreadFork(server: AgentServer) {
  const connect = server.connectInProcess.bind(server);
  server.connectInProcess = () => {
    const client = connect();
    const onFrame = client.onFrame.bind(client);
    client.onFrame = listener => onFrame(frame => {
      if ("result" in frame && frame.result && typeof frame.result === "object" && "capabilities" in frame.result) {
        const result = structuredClone(frame.result) as JsonObject & {capabilities:JsonObject};
        delete result.capabilities.midThreadFork;
        listener({...frame,result});
      } else listener(frame);
    });
    return client;
  };
}
