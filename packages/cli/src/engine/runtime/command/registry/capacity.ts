import {
    agentSettingsDiscoveryFailedEventCodec,
    decodeRelayToDaemonMessage,
    fileFailedEventCodec,
    readUndecodedRequestAddress,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import type { CommandContext } from "../context.ts";
import { send } from "../transport.ts";

/** Answers only after authentication succeeds but the replay claim cannot be admitted. */
export async function reportAuthenticatedCapacity(
    { socket, payloadEncryption, signal }: Pick<CommandContext, "socket" | "payloadEncryption" | "signal">,
    encoded: string,
): Promise<boolean> {
    const route = decodeRelayToDaemonMessage(encoded);
    if (!("encrypted" in route) || route.kind === "session.events.subscribe") {
        return false;
    }
    const address = readUndecodedRequestAddress(encoded);
    if (address === null) {
        return false;
    }
    const reply = {
        requestId: address.requestId,
        code: "e2e_store_busy",
        message: "The Computer encryption store is busy",
    };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    switch (route.kind) {
        case "agent.settings.discover":
            send(
                socket,
                await agentSettingsDiscoveryFailedEventCodec.encode(
                    { kind: "agent.settings.discovery.failed", ...reply },
                    payloadEncryption,
                    deadline,
                ),
            );
            return true;
        case "content.write":
        case "content.commit":
            if (address.target === undefined) {
                return false;
            }
            send(
                socket,
                await fileFailedEventCodec.encode(
                    { kind: "file.failed", ...reply, target: address.target },
                    payloadEncryption,
                    deadline,
                ),
            );
            return true;
        case "computer.diagnostics.read":
        case "computer.ping":
        case "native.session.cancel":
        case "native.session.request":
        case "session.archive":
        case "session.cancel":
        case "session.cancel-before-start":
        case "session.config.read":
        case "session.configure":
        case "session.create":
        case "session.elicitation.respond":
        case "session.live-history.v2.page.load":
        case "session.list":
        case "session.permission.respond":
        case "session.prepare":
        case "session.preview-history.page.load":
        case "session.prompt":
        case "session.prompt.disposition":
        case "session.query":
        case "session.rename":
        case "session.restore":
        case "workspace.list":
            send(
                socket,
                await sessionOperationFailedEventCodec.encode(
                    {
                        kind: "session.operation.failed",
                        ...reply,
                        ...(address.target === undefined ? {} : { target: address.target }),
                    },
                    payloadEncryption,
                    deadline,
                ),
            );
            return true;
        default:
            return route satisfies never;
    }
}
