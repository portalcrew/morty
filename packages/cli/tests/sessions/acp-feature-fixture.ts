import { fileURLToPath } from "node:url";
import type {
    AcpSessionUpdate,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionEventPayload,
    SessionLiveEvent,
    SessionPermissionRequestedEvent,
} from "@portalcrew/morty-client/protocol";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type { SessionObserver } from "../../src/engine/session/api/session-api.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";

export const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

export class RecordingObserver implements SessionObserver {
    readonly elicitationResolutions: SessionElicitationResolvedEvent[] = [];
    readonly events: { readonly event: SessionEventPayload; readonly position: number }[] = [];
    readonly permissionArrived = Promise.withResolvers<SessionPermissionRequestedEvent>();
    readonly elicitationArrived = Promise.withResolvers<SessionElicitationRequestedEvent>();
    readonly #eventWaiters: Array<(event: SessionEventPayload) => void> = [];

    readonly onSessionEvent = (liveEvent: SessionLiveEvent): void => {
        if (liveEvent.type === "lifecycle-metadata") {
            switch (liveEvent.payload.kind) {
                case "session.permission.requested":
                    this.permissionArrived.resolve(liveEvent.payload.event);
                    break;
                case "session.elicitation.requested":
                    this.elicitationArrived.resolve(liveEvent.payload.event);
                    break;
                case "session.elicitation.resolved":
                    this.elicitationResolutions.push(liveEvent.payload.event);
                    break;
            }
        }
        const event: SessionEventPayload =
            liveEvent.type === "acp"
                ? { payload: liveEvent.payload, type: "acp" }
                : { payload: liveEvent.payload, type: "lifecycle-metadata" };
        this.events.push({
            event,
            position: Number(liveEvent.position),
        });
        for (const resolve of this.#eventWaiters.splice(0)) {
            resolve(event);
        }
    };

    /** Resolves on the next recorded session event, without polling or timing. */
    readonly nextEvent = (): Promise<SessionEventPayload> =>
        new Promise((resolve) => {
            this.#eventWaiters.push(resolve);
        });

    readonly waitForEvent = async (predicate: (event: SessionEventPayload) => boolean): Promise<void> => {
        for (;;) {
            if (this.events.some(({ event }) => predicate(event))) {
                return;
            }
            await this.nextEvent();
        }
    };

    readonly turnStarted = (): Promise<void> => this.waitForEvent((event) => event.type === "acp");

    /** Concatenated agent reply text, folded from the same events clients read.
     * Commentary-phase progress chunks are excluded, matching the answer text
     * consumers render rather than the transient progress indicator. */
    readonly agentText = (): string =>
        this.acpUpdates()
            .flatMap((update) => {
                if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
                    return [];
                }
                return update.messageId.startsWith("progress-") ? [] : [update.content.text];
            })
            .join("");

    readonly acpUpdates = (): readonly AcpSessionUpdate[] =>
        this.events.flatMap(({ event }) => (event.type === "acp" ? [event.payload] : []));

    readonly toolUpdates = (toolCallId: string): readonly AcpSessionUpdate[] =>
        this.acpUpdates().filter(
            (update): update is Extract<AcpSessionUpdate, { readonly toolCallId: string }> =>
                (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                update.toolCallId === toolCallId,
        );
}

export function fakeAgent(
    additionalArguments: readonly string[] = [],
    environment: Readonly<Record<string, string>> = {},
    harness = "codex",
): AcpAgentDefinition {
    return createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness,
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Codex", ...additionalArguments],
                    environment: options.environment,
                },
                options,
            ),
        harness,
        "Codex",
        process.execPath,
        environment,
    );
}
