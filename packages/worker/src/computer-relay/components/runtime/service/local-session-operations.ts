import type { FileReadCommandRouting, NativeSessionTarget, SessionAccessGrant } from "@morty-build/client/protocol";
import {
    type AgentSettingsDiscoverCommandRouting,
    contentWriteCommandCodec,
    decodeMessageKind,
    decodeWorkerFileCredit,
    decodeWorkerRequestCancel,
    ProtocolMessageError,
    type SessionEventsSubscribeCommandRouting,
    WORKER_FILE_CREDIT_KIND,
    WORKER_REQUEST_CANCEL_KIND,
} from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import type { RuntimeContext } from "../runtime-context.ts";
import type { ClientControlCommand } from "./computer-control-registry.ts";
import {
    requestClientControl,
    requestComputerAgentSettings,
    requestComputerContentWrite,
    requestComputerFile,
} from "./computer-control-request.ts";
import { ContentUploadReader } from "./content-upload-reader.ts";

export type LocalSessionOperations = Readonly<ReturnType<typeof createLocalSessionOperations>>;

export function createLocalSessionOperations(cx: RuntimeContext, computerId: string) {
    const checkTarget = (requestedComputer: string) => {
        const latest = cx.services.connections.latest();
        if (requestedComputer !== computerId || latest === null) {
            throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
        }
        const daemon = cx.gateways.peers.sockets().find(({ identity }) => identity.role === "daemon");
        if (daemon !== undefined && daemon.identity.computerId !== computerId) {
            throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
        }
    };
    const connect = async (requestId: string, target: NativeSessionTarget | undefined, signal: AbortSignal) => {
        signal.throwIfAborted();
        await cx.services.runtime.expireSilentDaemons();
        signal.throwIfAborted();
        return cx.gateways.requests.open(requestId, target, async (socket, message) => {
            if (typeof message === "string" && decodeMessageKind(message) === WORKER_FILE_CREDIT_KIND) {
                const credit = decodeWorkerFileCredit(message);
                if (credit.requestId !== requestId) {
                    throw new PairingDirectoryError("invalid_request", "The credit does not own this operation");
                }
                signal.throwIfAborted();
                cx.services.runtime.grantFileCredit(computerId, socket, requestId, signal);
                return;
            }
            if (typeof message === "string" && decodeMessageKind(message) === WORKER_REQUEST_CANCEL_KIND) {
                const cancellation = decodeWorkerRequestCancel(message);
                if (cancellation.requestId !== requestId) {
                    throw new PairingDirectoryError("invalid_request", "The cancellation does not own this operation");
                }
                const cleanup = new AbortController();
                const timer = setTimeout(
                    () => cleanup.abort(new DOMException("Cancellation timed out", "TimeoutError")),
                    15_000,
                );
                try {
                    cx.services.runtime.cancelRequest(computerId, socket, requestId, cleanup.signal);
                } finally {
                    clearTimeout(timer);
                }
                return;
            }
            if (!signal.aborted) {
                await cx.services.runtime.receiveOperation(computerId, socket, message, signal);
                return;
            }
            throw signal.reason;
        });
    };
    return {
        requestClientControl: async (
            requestedComputerId: string,
            command: ClientControlCommand,
            signal: AbortSignal,
        ) => {
            checkTarget(requestedComputerId);
            const requestId = command.requestId;
            const target = "target" in command ? command.target : undefined;
            const execute = async (operationSignal: AbortSignal) => {
                checkTarget(requestedComputerId);
                return await requestClientControl(
                    await connect(requestId, target, operationSignal),
                    command,
                    operationSignal,
                    command.kind === "native.session.request" && command.action === "fork" ? signal : undefined,
                );
            };
            if (command.kind === "native.session.request" && command.action === "fork") {
                return await cx.gateways.requests.runRecoverableFork(requestId, signal, execute);
            }
            return await execute(signal);
        },
        requestAgentSettings: async (
            requestedComputerId: string,
            command: AgentSettingsDiscoverCommandRouting,
            signal: AbortSignal,
        ): Promise<string> => {
            checkTarget(requestedComputerId);
            return await requestComputerAgentSettings(
                await connect(command.requestId, undefined, signal),
                command,
                signal,
            );
        },
        subscribeSessionEvents: async (
            requestedComputerId: string,
            sessionTarget: NativeSessionTarget,
            subscription: SessionEventsSubscribeCommandRouting,
            credential: {
                readonly signingKeyId: string;
                readonly grant: SessionAccessGrant;
                readonly expiresAt: number;
            },
            observer: SessionEventObserver,
            signal: AbortSignal,
        ): Promise<void> => {
            checkTarget(requestedComputerId);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(requestedComputerId);
            if (!cx.services.runtime.isOnline()) {
                throw new PairingDirectoryError("computer_offline", "The Computer is offline");
            }
            if (
                cx.gateways.peers.viewers().some(({ identity }) => identity.subscriptionId === subscription.subscriptionId)
            ) {
                throw new PairingDirectoryError("invalid_request", "The subscription identifier is already in use");
            }
            // The viewer is registered before the Computer is told, so events that arrive while it admits are buffered.
            const release = cx.gateways.viewers.open(
                {
                    role: "viewer",
                    computerId,
                    sessionFilter: sessionTarget,
                    subscriptionId: subscription.subscriptionId,
                    expiresAt: credential.expiresAt,
                    credential: {
                        signingKeyId: credential.signingKeyId,
                        grant: credential.grant,
                    },
                },
                observer,
                signal,
            );
            try {
                await cx.services.runtime.registerSessionSubscription(computerId, sessionTarget, subscription, signal);
            } catch (cause) {
                release();
                throw cause;
            }
        },
        readSessionFile: async (
            requestedComputerId: string,
            command: FileReadCommandRouting,
            signal: AbortSignal,
        ): Promise<Response> => {
            checkTarget(requestedComputerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                const stream = await requestComputerFile(socket, command, signal);
                cx.utilities.waitUntil(stream.finished);
                return stream.response;
            } catch (cause) {
                socket.close(1000, "File request ended");
                throw cause;
            }
        },
        writeSessionContent: async (
            requestedComputerId: string,
            target: NativeSessionTarget,
            body: ReadableStream<Uint8Array>,
            signal: AbortSignal,
        ): Promise<string> => {
            checkTarget(requestedComputerId);
            using deadline = new RequestDeadline(signal, 120_000);
            const records = new ContentUploadReader(body);
            try {
                const first = await records.read(deadline.signal);
                if (first?.kind !== "message") {
                    throw new SessionRuntimeError("invalid_request", "The content write command is required");
                }
                const command = contentWriteCommandCodec.decodeRouting(first.encoded);
                if (command.target.harness !== target.harness || command.target.sessionId !== target.sessionId) {
                    throw new SessionRuntimeError("invalid_request", "The content upload does not match its Session");
                }
                const socket = await connect(command.requestId, target, deadline.signal);
                try {
                    return await requestComputerContentWrite(socket, first.encoded, records, deadline.signal);
                } catch (cause) {
                    socket.close(1000, "Content upload ended");
                    throw cause;
                }
            } catch (cause) {
                deadline.signal.throwIfAborted();
                if (cause instanceof ProtocolMessageError) {
                    throw new SessionRuntimeError("invalid_request", "The encrypted content upload is invalid", {
                        cause,
                    });
                }
                throw cause;
            } finally {
                await records.close();
            }
        },
    };
}
