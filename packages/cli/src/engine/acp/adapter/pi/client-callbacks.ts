import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import { type HarnessCallbackParams, HarnessClientEvents } from "../harness-client-events.ts";
import type { HarnessLifetime } from "../harness-session.ts";

/** Pi has no message identifiers; retain its submission boundaries while assigning Morty identities. */
export function piClientCallbacks(
    params: HarnessCallbackParams,
    externalizer: Pick<AcpContentExternalizer, "update">,
    lifetime: HarnessLifetime,
): PiAcpClient & { readonly drained: () => Promise<void> } {
    const events = new HarnessClientEvents("pi", params, externalizer, lifetime);
    let message:
        | { readonly kind: "none" }
        | {
              readonly kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
              readonly messageId: string;
          } = { kind: "none" };
    return {
        sessionUpdate: async (notification) => {
            const update = notification.update;
            switch (update.sessionUpdate) {
                case "user_message_chunk":
                case "agent_message_chunk":
                case "agent_thought_chunk":
                    if (message.kind !== update.sessionUpdate) {
                        message = { kind: update.sessionUpdate, messageId: crypto.randomUUID() };
                    }
                    await events.receive({ ...notification, update: { ...update, messageId: message.messageId } });
                    return;
                default:
                    message = { kind: "none" };
                    await events.receive({ ...notification, update });
            }
        },
        drained: events.drained,
        startUserMessage: () => {
            message = { kind: "none" };
        },
        requestPermission: (request) => events.permission(request, lifetime.signal),
        requestElicitation: events.elicitation,
    };
}
