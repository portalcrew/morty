import type { PayloadEncryptionConnection } from "@morty-build/client";
import { type NativeSessionCommand, nativeSessionResultCodec } from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { operationErrorCode } from "../../infra/operation-error.ts";
import { SessionError } from "../../session/api/session-error.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { Timer } from "../../util/timer.ts";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import { reportOperationFailure } from "./transport.ts";
import { reply } from "./turn-replies.ts";

type PendingRequest = Readonly<{
    harness: string;
    controller: AbortController;
    completion: Promise<void>;
}>;

interface NativeRequestDependencies {
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly nativeSessions: NativeSessionService;
    readonly signal: AbortSignal;
    readonly socket: WebSocket;
    readonly payloadEncryption: PayloadEncryptionConnection;
    readonly timer: Timer;
}

export function createNativeSessionRequestHandler(dependencies: NativeRequestDependencies) {
    const { diagnostics, nativeSessions, signal, socket, timer } = dependencies;
    const pending = new Map<string, PendingRequest>();

    const cancel = (requestId: string): void => {
        const request = pending.get(requestId);
        if (request !== undefined) {
            request.controller.abort(
                new SessionError("native_session_cancelled", "Native session operation cancelled"),
            );
        }
    };

    const handle = (command: NativeSessionCommand): void | Promise<void> => {
        const harness = command.action === "active-turn" ? command.target.harness : command.harness;
        const previous = [...pending.values()].filter((request) => request.harness === harness);
        // Serialize native operations per Agent within the existing bounded, cancellable admission window.
        if (pending.has(command.requestId) || pending.size >= 4) {
            return reportOperationFailure(
                dependencies,
                command.requestId,
                command.action === "active-turn" ? command.target : undefined,
                new SessionError("native_session_busy", "Another native session operation is running"),
            );
        }

        const controller = new AbortController();
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () => controller.abort(new SessionError("native_session_timeout", "Native session operation timed out")),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                operationSignal.throwIfAborted();
                const skipPrevious = command.action === "active-turn";
                if (previous.length > 0 && !skipPrevious) {
                    await waitForSharedOperation(
                        Promise.all(previous.map((request) => request.completion)),
                        operationSignal,
                    );
                }
                operationSignal.throwIfAborted();
                const result = await nativeSessions.execute(command, operationSignal);
                if (socket.readyState === WebSocket.OPEN) {
                    reply(
                        socket,
                        await nativeSessionResultCodec.encode(result, dependencies.payloadEncryption, operationSignal),
                    );
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new SessionError("native_session_cancelled", "Native session operation cancelled"))
                    : error;
                const event = "native_session_operation_failed";
                diagnostics.daemonDiagnostic(
                    event,
                    command.requestId,
                    {
                        action: command.action,
                        harness,
                        code: operationErrorCode(failure),
                    },
                    failure,
                );
                await reportOperationFailure(
                    dependencies,
                    command.requestId,
                    command.action === "active-turn" ? command.target : undefined,
                    failure,
                );
            } finally {
                timeout.cancel();
                pending.delete(command.requestId);
            }
        })();
        pending.set(command.requestId, {
            harness,
            controller,
            completion,
        });
    };

    const settle = async (): Promise<void> => {
        await Promise.all([...pending.values()].map((request) => request.completion));
    };

    return { cancel, handle, settle };
}
