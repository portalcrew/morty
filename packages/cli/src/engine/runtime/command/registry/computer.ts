import {
    type COMPUTER_PING_KIND,
    COMPUTER_PONG_KIND,
    computerDiagnosticsResultCodec,
    computerPongEventCodec,
    computerUpdateRestartingCodec,
} from "@portalcrew/morty-client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { runtimeEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { CommandHandler } from "../definition.ts";
import { replyFailure, reportOperationFailure, send } from "../transport.ts";

export const handleComputerDiagnostics: CommandHandler<"computer.diagnostics.read"> = async (
    context,
    message,
): Promise<void> => {
    const { computerUpdate, config, diagnostics, signal, socket, payloadEncryption } = context;
    try {
        send(
            socket,
            await computerDiagnosticsResultCodec.encode(
                {
                    kind: "computer.diagnostics.result",
                    requestId: message.requestId,
                    version: packageMetadata.version,
                    ...(computerUpdate === null ? {} : { remoteUpdate: "supported" as const }),
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

export const handleComputerUpdate: CommandHandler<"computer.update"> = async (context, message): Promise<void> => {
    const { computerUpdate, payloadEncryption, signal, socket } = context;
    if (computerUpdate === null) {
        await replyFailure(
            context,
            message.requestId,
            undefined,
            "unsupported_operation",
            "This Computer cannot update itself.",
        );
        return;
    }
    const restarting = await computerUpdateRestartingCodec.encode(
        { kind: "computer.update.restarting", requestId: message.requestId, version: message.version },
        payloadEncryption,
        signal,
    );
    try {
        await computerUpdate.restartInto(message.version, () => send(socket, restarting), signal);
    } catch (error) {
        signal.throwIfAborted();
        await reportOperationFailure(context, message.requestId, undefined, error);
    }
};
