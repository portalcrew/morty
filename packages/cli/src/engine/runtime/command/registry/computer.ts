import {
    type COMPUTER_PING_KIND,
    COMPUTER_PONG_KIND,
    computerDiagnosticsResultCodec,
    computerPongEventCodec,
} from "@morty-build/client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { runtimeEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { CommandHandler } from "../definition.ts";
import { replyFailure, send } from "../transport.ts";

export const handleComputerDiagnostics: CommandHandler<"computer.diagnostics.read"> = async (
    context,
    message,
): Promise<void> => {
    const { config, diagnostics, signal, socket, payloadEncryption } = context;
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
        await replyFailure(
            context,
            message.requestId,
            undefined,
            "diagnostics_unavailable",
            "Local diagnostics are unavailable.",
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
