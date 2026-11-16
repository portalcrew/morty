import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import { AgentUpdateStream } from "../../../src/engine/acp/connection/agent-update-stream.ts";
import type { IdentifiedSessionNotification as SessionNotification } from "../../../src/engine/acp/connection/session-notification.ts";
import { sessionIdSchema } from "../../../src/engine/acp/protocol/native-session.ts";

const MAX_PENDING_UPDATES = 100;
const MAX_PENDING_BYTES = 1024 * 1024;

type Selection =
    | {
          readonly kind: "awaiting-session";
          readonly notifications: readonly SessionNotification[];
          readonly bytes: number;
      }
    | { readonly kind: "selected"; readonly sessionId: string };

export class ControlledSessionUpdates {
    #selection: Selection = { kind: "awaiting-session", notifications: [], bytes: 0 };
    readonly #updates: AgentUpdateStream;

    constructor(consume: (notification: SessionNotification) => Promise<void>) {
        this.#updates = new AgentUpdateStream(consume);
    }

    readonly sessionId = (): string => (this.#selection.kind === "selected" ? this.#selection.sessionId : "");
    readonly drained = (): Promise<void> => this.#updates.drained();

    readonly receive = (notification: SessionNotification): Promise<void> => {
        const selection = this.#selection;
        switch (selection.kind) {
            case "selected":
                return this.#updates.receive(notification);
            case "awaiting-session": {
                const bytes = selection.bytes + Buffer.byteLength(JSON.stringify(notification));
                if (selection.notifications.length >= MAX_PENDING_UPDATES || bytes > MAX_PENDING_BYTES) {
                    return Promise.reject(
                        new AcpExecutionError(
                            "ACP agent sent too many updates before creating its session",
                            {},
                            "agent_update_limit",
                        ),
                    );
                }
                this.#selection = {
                    kind: "awaiting-session",
                    notifications: [...selection.notifications, notification],
                    bytes,
                };
                return Promise.resolve();
            }
        }
    };

    readonly select = (sessionId: string): void => {
        const selected = sessionIdSchema.parse(sessionId);
        const selection = this.#selection;
        switch (selection.kind) {
            case "selected":
                if (selection.sessionId !== selected) {
                    throw new AcpExecutionError(
                        "ACP agent attempted to replace the selected session",
                        {},
                        "invalid_agent_session",
                    );
                }
                return;
            case "awaiting-session":
                this.#selection = { kind: "selected", sessionId: selected };
                for (const notification of selection.notifications) {
                    void this.#updates.receive(notification);
                }
                return;
        }
    };
}
