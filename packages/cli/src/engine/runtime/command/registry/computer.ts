import {
    type COMPUTER_PING_KIND,
    COMPUTER_PONG_KIND,
    computerDiagnosticsResultCodec,
    computerPongEventCodec,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { runtimeEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { CommandHandler } from "../definition.ts";
import { send } from "../transport.ts";

export const handleComputerDiagnostics: CommandHandler<"computer.diagnostics.read"> = async (
    { config, diagnostics, signal, socket, payloadEncryption },
    message,
): Promise<void> => {
    try {
        send(
            socket,
            await computerDiagnosticsResultCodec.encode(
                {
                    kind: "computer.diagnostics.result",
                    requestId: message.requestId,
                    version: packageMetadata.version,
                    ...diagnostics.snapshot(runtimeEnvironmentDiagnostics(config)),
                },
                payloadEncryption,
                signal,
            ),
        );
    } catch {
        signal.throwIfAborted();
        send(
            socket,
            await sessionOperationFailedEventCodec.encode(
                {
                    kind: "session.operation.failed",
                    requestId: message.requestId,
                    code: "diagnostics_unavailable",
                    message: "Local diagnostics are unavailable.",
                },
                payloadEncryption,
                signal,
            ),
        );
    }
};

export const handleComputerPing: CommandHandler<typeof COMPUTER_PING_KIND> = async (
    { socket, signal, payloadEncryption },
    message,
): Promise<void> => {
    send(
        socket,
        await computerPongEventCodec.encode(
            { kind: COMPUTER_PONG_KIND, requestId: message.requestId },
            payloadEncryption,
            signal,
        ),
    );
};
