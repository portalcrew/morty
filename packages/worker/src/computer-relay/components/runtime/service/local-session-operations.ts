import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    AgentSettingsDiscoverCommand,
    AgentSettingsDiscoveredEvent,
    ContentAvailableEvent,
    ContentWriteCommand,
    FileReadCommand,
    NativeSessionResult,
    NativeSessionTarget,
    SessionAccessGrant,
    WorkspaceEntriesEvent,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { decodeNativeSessionCancel, requestReplyAddress } from "@morty-build/client/protocol";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { RuntimeContext } from "../runtime-context.ts";
import {
    type ComputerControlCommand,
    type ComputerControlResult,
    requestComputerAgentSettings,
    requestComputerContentWrite,
    requestComputerControl,
    requestComputerFile,
    requestComputerWorkspace,
} from "./computer-control-request.ts";

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
        return cx.gateways.requests.open(requestId, target, async (socket, message) => {
            if (!signal.aborted) {
                await cx.services.runtime.receiveOperation(computerId, socket, message, signal);
                return;
            }
            // The caller has left, but native query cancellation must still reach the daemon.
            if (typeof message !== "string") {
                throw signal.reason;
            }
            const cancellation = decodeNativeSessionCancel(message);
            if (cancellation.requestId !== requestId) {
                throw signal.reason;
            }
            const cleanup = new AbortController();
            const timer = setTimeout(
                () => cleanup.abort(new DOMException("Cancellation timed out", "TimeoutError")),
                15_000,
            );
            try {
                await cx.services.runtime.receiveOperation(computerId, socket, message, cleanup.signal);
            } finally {
                clearTimeout(timer);
            }
        });
    };
    const requestControl = async (
        requestedComputerId: string,
        command: ComputerControlCommand,
        signal: AbortSignal,
    ): Promise<ComputerControlResult> => {
        checkTarget(requestedComputerId);
        const target = "target" in command ? command.target : undefined;
        const socket = await connect(requestReplyAddress(command), target, signal);
        return await requestComputerControl(socket, command, signal);
    };
    return {
        forkNativeSession: async (
            requestedComputerId: string,
            operationId: string,
            input: ForkMortyNativeSessionRequest,
            signal: AbortSignal,
        ): Promise<NativeSessionResult> => {
            checkTarget(requestedComputerId);
            return await cx.services.nativeForks.fork(requestedComputerId, operationId, input, requestControl, signal);
        },
        requestWorkspace: async (
            requestedComputerId: string,
            command: WorkspaceListCommand,
            signal: AbortSignal,
        ): Promise<WorkspaceEntriesEvent> => {
            checkTarget(requestedComputerId);
            return await requestComputerWorkspace(await connect(command.requestId, undefined, signal), command, signal);
        },
        requestAgentSettings: async (
            requestedComputerId: string,
            command: AgentSettingsDiscoverCommand,
            signal: AbortSignal,
        ): Promise<AgentSettingsDiscoveredEvent> => {
            checkTarget(requestedComputerId);
            return await requestComputerAgentSettings(
                await connect(command.requestId, undefined, signal),
                command,
                signal,
            );
        },
        openPublicSessionEvents: async (
            requestedComputerId: string,
            sessionTarget: NativeSessionTarget,
            credential: {
                readonly signingKeyId: string;
                readonly grant: SessionAccessGrant;
                readonly expiresAt: number;
            },
            signal: AbortSignal,
        ): Promise<Response> => {
            checkTarget(requestedComputerId);
            signal.throwIfAborted();
            await cx.services.runtime.expireSilentDaemons();
            checkTarget(requestedComputerId);
            if (!cx.services.runtime.isOnline()) {
                throw new PairingDirectoryError("computer_offline", "The Computer is offline");
            }
            return cx.gateways.peers.accept({
                role: "viewer",
                computerId,
                sessionFilter: sessionTarget,
                expiresAt: credential.expiresAt,
                credential: {
                    signingKeyId: credential.signingKeyId,
                    grant: credential.grant,
                },
            }).response;
        },
        requestControl,
        readSessionFile: async (
            requestedComputerId: string,
            command: FileReadCommand,
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
            command: ContentWriteCommand,
            body: ReadableStream<Uint8Array>,
            signal: AbortSignal,
        ): Promise<ContentAvailableEvent> => {
            checkTarget(requestedComputerId);
            const socket = await connect(command.requestId, command.target, signal);
            try {
                return await requestComputerContentWrite(socket, command, body, signal);
            } catch (cause) {
                socket.close(1000, "Content upload ended");
                throw cause;
            }
        },
    };
}
