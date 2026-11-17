import { nativeSessionKey, sameNativeSession } from "@portalcrew/morty-client/native-session";
import {
    COMPUTER_LIVENESS_READY_KIND,
    type ComputerLivenessReadyEvent,
    type DaemonToRelayMessage,
    decodeDaemonToRelayMessage,
    ENCRYPTED_MESSAGE_MAX_WIRE_BYTES,
    encodeComputerLivenessReadyEvent,
    type NativeSessionTarget,
    SESSION_EVENT_KIND,
    type SessionEventsSubscribeCommandRouting,
} from "@portalcrew/morty-client/protocol";
import { ComputerStatus } from "../../../../contracts/relay/computer-status.ts";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";
import type { logger } from "../../../../infra/logger.ts";
import type { ComputerConnectionIdentity } from "../entity/computer-connection.ts";
import {
    type DaemonConnectionEnding,
    daemonCloseFrame,
    daemonEndingLogFields,
    isExpectedDaemonEnding,
} from "../entity/connection-ending.ts";
import { sessionViewerAccess } from "../entity/session-viewer-access.ts";
import type { ComputerCredentialService } from "./computer-credential-service.ts";
import { ComputerMessageScheduler, ComputerMessageSchedulerCapacityError } from "./computer-message-scheduler.ts";
import type { ComputerOperationSocket, ComputerRelayActor, RelayPeers, RelaySocket } from "./computer-relay-actor.ts";
import type { DaemonConnectionService } from "./daemon-connection-service.ts";

const DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS = 30_000;

const DAEMON_DETACH_TIMEOUT_MILLISECONDS = 30_000;

// A live daemon heartbeats every 20 seconds and abandons a connection whose acknowledgement takes
// longer than 10 seconds. A daemon silent past both, plus delivery slack, has lost this connection
// even though the Relay never saw it close, so commands sent into it would never be answered.
const DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS = 35_000;

export type DaemonHeartbeat = { readonly kind: "none" } | { readonly kind: "received"; readonly at: number };

export interface ComputerPeers extends RelayPeers {
    readonly daemonConnections: () => readonly {
        readonly identity: ComputerConnectionIdentity;
        readonly socket: RelaySocket;
        readonly heartbeat: DaemonHeartbeat;
    }[];
    readonly accept: (identity: ComputerConnectionIdentity) => {
        readonly socket: RelaySocket;
        readonly response: Response;
    };
}

type ComputerPeer = ReturnType<ComputerPeers["daemonConnections"]>[number];

interface RuntimeContext {
    readonly services: {
        readonly connections: DaemonConnectionService;
        readonly credentials: ComputerCredentialService;
        readonly relay: ComputerRelayActor;
    };
    readonly gateways: {
        readonly peers: ComputerPeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
    readonly logger: typeof logger;
}

export type ComputerAdmission =
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

export type ComputerConnectionOperations = Pick<ComputerService, "acceptDaemon" | "revokeComputer" | "readStatus">;

export class ComputerService {
    readonly #cx: RuntimeContext;
    readonly #daemonMessages = new ComputerMessageScheduler();
    readonly #attachments = new Set<{
        readonly controller: AbortController;
        readonly identity: ComputerConnectionIdentity;
    }>();
    #acceptTail: Promise<void> = Promise.resolve();
    readonly #accepting = new Set<AbortController>();

    constructor(cx: RuntimeContext) {
        this.#cx = cx;
    }

    readonly readStatus = async (signal: AbortSignal): Promise<ComputerStatus> => {
        signal.throwIfAborted();
        await this.expireSilentDaemons();
        signal.throwIfAborted();
        return new ComputerStatus(this.isOnline());
    };

    readonly acceptDaemon = (signal: AbortSignal) =>
        this.admit(signal, (admission, generation) => {
            const operation = this.#acceptTail.then(() => this.acceptDaemonSocket(admission, generation));
            this.#acceptTail = operation.then(
                () => undefined,
                () => undefined,
            );
            return operation;
        });

    /**
     * Admits a connection only while a generation of this Computer is active, under that generation. The pending
     * admission is registered before that authority is read: a revocation committed after the read is notified
     * after it, and the notification aborts the admission. `accept` must check the admission signal and then
     * accept without awaiting, so a later notification finds the accepted socket and closes it.
     */
    private readonly admit = async <T>(
        signal: AbortSignal,
        accept: (admission: AbortSignal, generation: number) => Promise<T>,
    ): Promise<T | { readonly kind: "revoked" }> => {
        const pending = new AbortController();
        this.#accepting.add(pending);
        try {
            const admission = AbortSignal.any([signal, pending.signal]);
            const generation = await this.#cx.services.credentials.activeGeneration(admission);
            if (generation === null) {
                return { kind: "revoked" };
            }
            return await accept(admission, generation);
        } catch (error) {
            signal.throwIfAborted();
            if (pending.signal.aborted) {
                return { kind: "revoked" };
            }
            throw error;
        } finally {
            this.#accepting.delete(pending);
        }
    };

    private readonly acceptDaemonSocket = (signal: AbortSignal, generation: number): ComputerAdmission => {
        // Nothing below awaits, so this admission check and accept + connect are one step.
        signal.throwIfAborted();
        const identity = this.#cx.services.connections.next();
        const latest = this.#cx.services.connections.latest();
        if (latest !== null && latest.generation !== generation) {
            this.#cx.services.relay.endViewers({ kind: "pairing_replaced", replacement: identity });
            for (const daemon of this.#cx.gateways.peers.daemonConnections()) {
                this.closeDaemon(daemon.identity, daemon.socket, { kind: "pairing_replaced", replacement: identity });
            }
            for (const { socket } of this.#cx.gateways.peers.operations()) {
                socket.close(1000, "Previous daemon disconnected");
            }
        }
        const previous = this.#cx.gateways.peers.daemonConnections().filter(({ socket }) => socket.isOpen());
        for (const attachment of this.#attachments) {
            attachment.controller.abort(new DOMException("Computer connection replaced", "AbortError"));
        }
        for (const daemon of previous) {
            this.#cx.services.relay.failTransfersOwnedBy(daemon.socket);
            this.closeDaemon(daemon.identity, daemon.socket, { kind: "replaced", replacement: identity });
        }
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(identity, generation, Date.now());
        this.#cx.logger.info({ ...identity, event: "computer_websocket_accepted" }, "Computer WebSocket accepted");
        this.deferDaemonAttachment(identity, accepted.socket, previous.length > 0);
        return { kind: "accepted", response: accepted.response };
    };

    private readonly deferDaemonAttachment = (
        identity: ComputerConnectionIdentity,
        socket: RelaySocket,
        replaced: boolean,
    ): void => {
        const attachment = { controller: new AbortController(), identity };
        this.#attachments.add(attachment);
        // An uncancellable AbortSignal.timeout would keep this Durable Object awake for the whole deadline
        // after the attachment finished, so the timer is cleared once it settles.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The Computer attachment timed out", "TimeoutError")),
            DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS,
        );
        const signal = AbortSignal.any([attachment.controller.signal, timeout.signal]);
        const operation = (async () => {
            try {
                this.#cx.services.relay.attachDaemon(replaced);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    return;
                }
                const ready: ComputerLivenessReadyEvent = {
                    kind: COMPUTER_LIVENESS_READY_KIND,
                    connectionEpoch: identity.connectionEpoch,
                };
                socket.send(encodeComputerLivenessReadyEvent(ready));
                // The readiness frame is the daemon's first; ending the old subscriptions tells it about each after.
                if (replaced) {
                    this.#cx.services.relay.endViewers({ kind: "daemon_replaced", replacement: identity });
                }
            } catch (error) {
                if (this.#cx.services.connections.isCurrent(identity)) {
                    this.closeDaemon(identity, socket, { kind: "attachment_failed" }, error);
                } else if (!attachment.controller.signal.aborted) {
                    this.#cx.logger.error(
                        { ...identity, err: error, event: "computer_attachment_failed" },
                        "Computer attachment failed",
                    );
                }
            } finally {
                clearTimeout(timer);
                this.#attachments.delete(attachment);
            }
        })();
        this.#cx.utilities.waitUntil(operation);
    };

    readonly revokeComputer = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        // The Computer's authority committed the revocation before notifying; acceptance and every
        // daemon message read that authority, so this notification only cleans up promptly. Its one fallible
        // step runs first, so a failed notification leaves this Relay unchanged for the caller to retry.
        // A delayed disconnect must not close the daemon that claimed a fresh authorization.
        if ((await this.#cx.services.credentials.activeGeneration(signal)) !== null) {
            return;
        }
        const latest = this.#cx.services.connections.latest();
        const connected = latest?.kind === "connected";
        if (connected) {
            this.#cx.services.connections.disconnected(latest.connectionEpoch, Date.now());
        }
        for (const accepting of this.#accepting) {
            accepting.abort(new DOMException("Computer revoked", "AbortError"));
        }
        for (const attachment of this.#attachments) {
            attachment.controller.abort(new DOMException("Computer revoked", "AbortError"));
        }
        for (const daemon of this.#cx.gateways.peers.daemonConnections()) {
            this.closeDaemon(daemon.identity, daemon.socket, { kind: "revoked" });
        }
        this.#cx.services.relay.endViewers({
            kind: "computer_revoked",
            connection: connected ? { connectionEpoch: latest.connectionEpoch } : null,
        });
        if (connected) {
            this.#cx.services.relay.refuseOperationsOffline();
        }
    };

    readonly reauthorizeConnections = async (signal: AbortSignal): Promise<void> => {
        for (const viewer of this.#cx.gateways.peers.viewers()) {
            const grant = await this.#cx.services.credentials.authorizeViewer(viewer.identity, signal);
            const access = sessionViewerAccess(viewer.identity, Date.now(), grant);
            if (access.kind === "ended") {
                viewer.close(access.code, access.reason);
            }
        }
    };

    /** Closes daemon connections that stopped heartbeating or were superseded, so presence reads report them offline. */
    readonly expireSilentDaemons = async (): Promise<void> => {
        await this.detachDaemons(this.closeSilentDaemons());
    };

    readonly isOnline = (): boolean => this.currentDaemon() !== undefined;

    /**
     * The open daemon socket that is this Computer's current connection. Whether a connection is current is the
     * connection record's fact alone; commands, subscriptions and presence all go to the socket it names, never to
     * one the socket's own attachment says is a daemon.
     */
    readonly currentDaemon = (): ComputerPeer | undefined =>
        this.#cx.gateways.peers
            .daemonConnections()
            .find(({ identity, socket }) => socket.isOpen() && this.#cx.services.connections.isCurrent(identity));

    readonly registerSessionSubscription = async (
        target: NativeSessionTarget,
        routing: SessionEventsSubscribeCommandRouting,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (!sameNativeSession(routing.target, target)) {
            throw new PairingDirectoryError("invalid_request", "The subscription does not match its Session");
        }
        const daemon = this.currentDaemon();
        if (daemon === undefined) {
            throw new PairingDirectoryError("computer_offline", "The Computer is offline");
        }
        signal.throwIfAborted();
        this.#cx.services.relay.forwardSessionSubscription(daemon.socket, routing);
    };

    /** The public HTTP handler already authorized this local operation. */
    readonly receiveOperation = async (
        socket: ComputerOperationSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const silent = this.closeSilentDaemons();
        try {
            const relay = this.#cx.services.relay;
            if (typeof message === "string") {
                await relay.receiveOperationMessage(socket, message, signal);
            } else {
                relay.receiveOperationChunk(socket, message);
            }
        } finally {
            await this.detachDaemons(silent);
        }
    };

    readonly cancelRequest = (operation: ComputerOperationSocket, requestId: string): void => {
        const daemon = this.requestControlDaemon(operation, requestId);
        if (daemon !== null) {
            this.#cx.services.relay.forwardRequestCancellation(daemon, requestId);
        }
    };

    readonly grantFileCredit = (operation: ComputerOperationSocket, requestId: string): void => {
        if (operation.requestTransferKind() !== "file-read") {
            throw new PairingDirectoryError("invalid_request", "The credit does not own a file read");
        }
        const daemon = this.requestControlDaemon(operation, requestId);
        if (daemon === null) {
            throw new PairingDirectoryError("computer_offline", "The Computer connection closed");
        }
        this.#cx.services.relay.forwardFileCredit(daemon, requestId);
    };

    private readonly requestControlDaemon = (
        operation: ComputerOperationSocket,
        requestId: string,
    ): RelaySocket | null => {
        const ownsOperation = this.#cx.gateways.peers
            .operations()
            .some((route) => route.requestId === requestId && route.socket.isSame(operation));
        if (!ownsOperation) {
            throw new PairingDirectoryError("invalid_request", "The cancellation does not own this operation");
        }
        const original = operation.requestDaemon();
        if (original === null) {
            return null;
        }
        const daemon = this.currentDaemon();
        if (daemon === undefined || !daemon.socket.isSame(original)) {
            return null;
        }
        return daemon.socket;
    };

    readonly receiveMessage = async (
        identity: ComputerConnectionIdentity,
        socket: RelaySocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (typeof message !== "string") {
            try {
                await this.#daemonMessages.run("runtime", signal, async () => {
                    signal.throwIfAborted();
                    if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                        return;
                    }
                    this.#cx.services.relay.receiveDaemonChunk(message);
                });
            } catch (error) {
                signal.throwIfAborted();
                this.closeDaemon(
                    identity,
                    socket,
                    {
                        kind: "invalid_content_chunk",
                        overCapacity: error instanceof ComputerMessageSchedulerCapacityError,
                    },
                    error,
                );
            }
            return;
        }
        if (
            message.length > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES ||
            new TextEncoder().encode(message).byteLength > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES
        ) {
            this.closeDaemon(identity, socket, { kind: "oversized_message" });
            return;
        }
        let daemonMessage: DaemonToRelayMessage | null;
        try {
            daemonMessage = decodeDaemonToRelayMessage(message);
        } catch {
            // Reject this frame without disconnecting unrelated Sessions.
            this.#cx.services.relay.recordSkipped("invalid_daemon_message");
            return;
        }
        const lane = daemonMessage === null ? "runtime" : this.daemonMessageLane(daemonMessage);
        try {
            await this.#daemonMessages.run(lane, signal, async () => {
                signal.throwIfAborted();
                if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                    return;
                }
                const relay = this.#cx.services.relay;
                await relay.receiveDaemonMessage(socket, daemonMessage, signal, message);
            });
        } catch (error) {
            if (error instanceof ComputerMessageSchedulerCapacityError) {
                this.closeDaemon(identity, socket, { kind: "message_queue_full", code: error.code }, error);
                return;
            }
            throw error;
        }
    };

    private readonly authorizeDaemonMessage = async (
        identity: ComputerConnectionIdentity,
        socket: RelaySocket,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        // Disconnect delivery can fail after revocation commits in Computer storage, and the Computer can stop being
        // served. Read that authority before every business message; the local connection fence alone is insufficient.
        try {
            if ((await this.#cx.services.credentials.activeGeneration(signal)) === null) {
                this.closeDaemon(identity, socket, { kind: "revoked" });
                return false;
            }
        } catch (error) {
            signal.throwIfAborted();
            this.closeDaemon(identity, socket, { kind: "authorization_unavailable" }, error);
            return false;
        }
        // A replacement may have been accepted while the authoritative lookup was in flight.
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        return socket.isOpen();
    };

    private readonly fenceDaemon = (identity: ComputerConnectionIdentity, socket: RelaySocket): boolean => {
        const standing = this.#cx.services.connections.standing(identity);
        if (standing === "current") {
            return false;
        }
        // A fenced socket may still deliver queued messages; its ending is recorded once.
        if (!socket.isOpen()) {
            return true;
        }
        switch (standing) {
            case "replaced": {
                const latest = this.#cx.services.connections.latest();
                this.closeDaemon(identity, socket, {
                    kind: "replaced",
                    replacement: latest?.kind === "connected" ? { connectionEpoch: latest.connectionEpoch } : null,
                });
                return true;
            }
            case "ended":
                this.closeDaemon(identity, socket, { kind: "revoked" });
                return true;
            default:
                return standing satisfies never;
        }
    };

    /** Records why the Relay closes a daemon connection before the close starts any cleanup. */
    private readonly closeDaemon = (
        identity: ComputerConnectionIdentity,
        socket: RelaySocket,
        ending: DaemonConnectionEnding,
        cause?: unknown,
    ): void => {
        const frame = daemonCloseFrame(ending);
        const record = {
            ...identity,
            ...daemonEndingLogFields(ending),
            event: "computer_connection_ending",
            closeCode: frame.code,
            ...(cause === undefined ? {} : { err: cause }),
        };
        if (isExpectedDaemonEnding(ending)) {
            this.#cx.logger.info(record, "Computer connection ending");
        } else {
            this.#cx.logger.warn(record, "Computer connection ending");
        }
        socket.close(frame.code, frame.reason);
    };

    /**
     * Each event batch declares one Session. Its public target selects the ordering lane without reading events.
     */
    private readonly daemonMessageLane = (message: DaemonToRelayMessage): string => {
        if (message.kind === SESSION_EVENT_KIND) {
            return `session:${nativeSessionKey(message.target)}`;
        }
        return "runtime";
    };

    readonly detachViewer = (identity: SessionViewerIdentity): void => {
        const daemon = this.currentDaemon();
        if (daemon === undefined) {
            return;
        }
        try {
            this.#cx.services.relay.forwardSessionUnsubscribe(
                daemon.socket,
                identity.subscriptionId,
                identity.sessionFilter,
            );
        } catch (error) {
            this.#cx.logger.warn(
                { err: error, event: "session_subscription_cleanup_failed" },
                "Session subscription cleanup failed",
            );
        }
    };

    readonly detach = async (identity: ComputerConnectionIdentity, signal: AbortSignal): Promise<void> => {
        // The latest connection detaches once it closes, also after its generation ended: what was sent into it
        // must still be released.
        const latest = () => this.#cx.services.connections.standing(identity) !== "replaced";
        if (!latest()) {
            return;
        }
        for (const attachment of this.#attachments) {
            if (attachment.identity.connectionEpoch === identity.connectionEpoch) {
                attachment.controller.abort(new DOMException("Computer connection closed", "AbortError"));
            }
        }
        await this.#daemonMessages.idle(signal);
        if (!latest()) {
            return;
        }
        this.#cx.services.connections.disconnected(identity.connectionEpoch, Date.now());
        this.#cx.services.relay.detachDaemon(identity);
    };

    private readonly closeSilentDaemons = (): readonly ComputerConnectionIdentity[] => {
        const now = Date.now();
        const silent: ComputerConnectionIdentity[] = [];
        for (const { identity, socket, heartbeat } of this.#cx.gateways.peers.daemonConnections()) {
            if (!socket.isOpen()) {
                continue;
            }
            // The host answers heartbeats without running the Relay, so a superseded connection that
            // keeps heartbeating is retired here instead of when it heartbeats.
            if (this.fenceDaemon(identity, socket)) {
                continue;
            }
            const heardAt = heartbeat.kind === "received" ? heartbeat.at : this.firstHeartbeatDue();
            if (heardAt === null || now - heardAt <= DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS) {
                continue;
            }
            this.closeDaemon(identity, socket, { kind: "heartbeat_silence", silenceMilliseconds: now - heardAt });
            silent.push(identity);
        }
        return silent;
    };

    /**
     * A daemon sends its first heartbeat once its attachment is ready, which the attachment deadline
     * bounds, so a connection still silent past that deadline counts as silent from it.
     */
    private readonly firstHeartbeatDue = (): number | null => {
        const current = this.#cx.services.connections.current();
        return current === null ? null : current.connectedAt + DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS;
    };

    // The connection may never report its close, so the Relay detaches it itself. The command or
    // read that noticed the silence may end first, so the detach does not share its cancellation.
    private readonly detachDaemons = async (daemons: readonly ComputerConnectionIdentity[]): Promise<void> => {
        for (const identity of daemons) {
            const timeout = new AbortController();
            const timer = setTimeout(
                () => timeout.abort(new DOMException("The Computer detach timed out", "TimeoutError")),
                DAEMON_DETACH_TIMEOUT_MILLISECONDS,
            );
            try {
                await this.detach(identity, timeout.signal);
            } finally {
                clearTimeout(timer);
            }
        }
    };
}
