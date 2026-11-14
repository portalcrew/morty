import { nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
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
} from "@morty-build/client/protocol";
import { ComputerStatus } from "../../../../contracts/relay/computer-status.ts";
import { PairingDirectoryError } from "../../../../contracts/relay/pairing.ts";
import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";
import { logger } from "../../../../infra/logger.ts";
import type { ComputerConnectionIdentity } from "../entity/computer-connection.ts";
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

/** Whether a heartbeat on a daemon connection has been answered, and when it last was. */
export type DaemonHeartbeat = { readonly kind: "none" } | { readonly kind: "received"; readonly at: number };

export type ComputerSocketIdentity =
    | SessionViewerIdentity
    | {
          readonly role: "daemon";
          readonly connectionEpoch: number;
          readonly computerId: string;
      };

export type ComputerSocket = RelaySocket;

export interface ComputerPeers extends RelayPeers {
    readonly sockets: () => readonly { readonly identity: ComputerSocketIdentity; readonly socket: ComputerSocket }[];
    /** Daemon connections with the time each one's heartbeat was last answered by the host. */
    readonly daemonConnections: () => readonly {
        readonly identity: ComputerSocketIdentity;
        readonly socket: ComputerSocket;
        readonly heartbeat: DaemonHeartbeat;
    }[];
    readonly accept: (identity: ComputerSocketIdentity) => {
        readonly socket: ComputerSocket;
        readonly response: Response;
    };
}

type ComputerPeer = ReturnType<ComputerPeers["sockets"]>[number];

interface RuntimeContext {
    readonly services: {
        readonly connections: DaemonConnectionService;
        readonly credentials: ComputerCredentialService;
        readonly relay: (computerId: string) => ComputerRelayActor;
    };
    readonly gateways: {
        readonly peers: ComputerPeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}

export type ComputerAdmission =
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

export type ComputerConnectionOperations = Pick<ComputerService, "acceptDaemon" | "revokeComputer" | "readStatus">;

type DaemonSocketIdentity = Extract<ComputerSocketIdentity, { readonly role: "daemon" }>;

export class ComputerService {
    readonly #cx: RuntimeContext;
    #channel: { readonly computerId: string; readonly actor: ComputerRelayActor } | undefined;
    readonly #daemonMessages = new ComputerMessageScheduler();
    readonly #attachments = new Set<{
        readonly controller: AbortController;
        readonly identity: DaemonSocketIdentity;
    }>();
    #acceptTail: Promise<void> = Promise.resolve();
    readonly #accepting = new Set<{
        readonly computerId: string;
        readonly controller: AbortController;
    }>();

    constructor(cx: RuntimeContext) {
        this.#cx = cx;
    }

    readonly readStatus = async (signal: AbortSignal): Promise<ComputerStatus> => {
        signal.throwIfAborted();
        await this.expireSilentDaemons();
        signal.throwIfAborted();
        return new ComputerStatus(this.isOnline());
    };

    readonly acceptDaemon = (computerId: string, signal: AbortSignal) =>
        this.admit(computerId, signal, (admission, generation) => {
            const operation = this.#acceptTail.then(() => this.acceptDaemonSocket(computerId, admission, generation));
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
        computerId: string,
        signal: AbortSignal,
        accept: (admission: AbortSignal, generation: number) => Promise<T>,
    ): Promise<T | { readonly kind: "revoked" }> => {
        const pending = { computerId, controller: new AbortController() };
        this.#accepting.add(pending);
        try {
            const admission = AbortSignal.any([signal, pending.controller.signal]);
            const runtime = { computerId };
            const generation = await this.#cx.services.credentials.activeGeneration(runtime, admission);
            if (generation === null) {
                return { kind: "revoked" };
            }
            return await accept(admission, generation);
        } catch (error) {
            signal.throwIfAborted();
            if (pending.controller.signal.aborted) {
                return { kind: "revoked" };
            }
            throw error;
        } finally {
            this.#accepting.delete(pending);
        }
    };

    private readonly acceptDaemonSocket = (
        computerId: string,
        signal: AbortSignal,
        generation: number,
    ): ComputerAdmission => {
        // Nothing below awaits, so this admission check and accept + connect are one step.
        signal.throwIfAborted();
        const latest = this.#cx.services.connections.latest();
        // The connections opened during an earlier generation belong to the Computer that generation paired.
        if (latest !== null && latest.generation !== generation) {
            for (const viewer of this.#cx.gateways.peers.viewers()) {
                viewer.close(1000, "Previous daemon disconnected");
            }
            for (const { socket } of this.#cx.gateways.peers.sockets()) {
                socket.close(1000, "Previous daemon disconnected");
            }
            for (const { socket } of this.#cx.gateways.peers.operations()) {
                socket.close(1000, "Previous daemon disconnected");
            }
        }
        const previous = this.#cx.gateways.peers
            .sockets()
            .filter(({ identity, socket }) => identity.role === "daemon" && socket.isOpen());
        for (const attachment of this.#attachments) {
            if (attachment.identity.computerId === computerId) {
                attachment.controller.abort(new DOMException("Computer connection replaced", "AbortError"));
            }
        }
        for (const { socket } of previous) {
            this.relay(computerId).failTransfersOwnedBy(socket);
            socket.close(1012, "Daemon connection replaced");
        }
        const connection = this.#cx.services.connections.next(computerId);
        const identity: DaemonSocketIdentity = { ...connection, role: "daemon" };
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(connection, generation, Date.now());
        logger.info({ ...identity, event: "computer_websocket_accepted" }, "Computer WebSocket accepted");
        this.deferDaemonAttachment(identity, accepted.socket, computerId, previous.length > 0);
        return { kind: "accepted", response: accepted.response };
    };

    private readonly deferDaemonAttachment = (
        identity: DaemonSocketIdentity,
        socket: ComputerSocket,
        computerId: string,
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
                await this.relay(computerId).attachDaemon(replaced);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    return;
                }
                const ready: ComputerLivenessReadyEvent = { kind: COMPUTER_LIVENESS_READY_KIND };
                socket.send(encodeComputerLivenessReadyEvent(ready));
                // The readiness frame is the daemon's first; ending the old subscriptions tells it about each after.
                if (replaced) {
                    this.relay(computerId).endSubscriptions();
                }
            } catch (error) {
                if (!attachment.controller.signal.aborted) {
                    logger.error(
                        { ...identity, err: error, event: "computer_attachment_failed" },
                        "Computer attachment failed",
                    );
                }
                if (this.#cx.services.connections.isCurrent(identity)) {
                    socket.close(1011, "Computer attachment failed");
                }
            } finally {
                clearTimeout(timer);
                this.#attachments.delete(attachment);
            }
        })();
        this.#cx.utilities.waitUntil(operation);
    };

    readonly revokeComputer = async (computerId: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        // The Computer's authority committed the revocation before notifying; acceptance and every
        // daemon message read that authority, so this notification only cleans up promptly. Its one fallible
        // step runs first, so a failed notification leaves this Relay unchanged for the caller to retry.
        // A delayed disconnect must not close the daemon that claimed a fresh authorization.
        if ((await this.#cx.services.credentials.activeGeneration({ computerId }, signal)) !== null) {
            return;
        }
        const latest = this.#cx.services.connections.latest();
        const connected = latest?.kind === "connected";
        if (connected) {
            this.#cx.services.connections.disconnected(latest.connectionEpoch, Date.now());
        }
        for (const accepting of this.#accepting) {
            if (accepting.computerId === computerId) {
                accepting.controller.abort(new DOMException("Computer revoked", "AbortError"));
            }
        }
        for (const attachment of this.#attachments) {
            if (attachment.identity.computerId === computerId) {
                attachment.controller.abort(new DOMException("Computer revoked", "AbortError"));
            }
        }
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (identity.computerId !== computerId) {
                continue;
            }
            if (identity.role === "daemon") {
                socket.close(1008, "Computer revoked");
            }
        }
        for (const viewer of this.#cx.gateways.peers.viewers()) {
            if (viewer.identity.computerId === computerId) {
                viewer.close(1008, "Computer revoked");
            }
        }
        if (connected) {
            this.notifyOffline();
        }
    };

    /**
     * Closes live Session views whose credential no longer authorizes them. The Relay checks as soon as access
     * to the computer ends, and periodically while views remain connected.
     */
    readonly reauthorizeConnections = async (signal: AbortSignal): Promise<void> => {
        for (const viewer of this.#cx.gateways.peers.viewers()) {
            if ((await this.#cx.services.credentials.authorizeViewer(viewer.identity, signal)) === "revoked") {
                viewer.close(1008, "Session access revoked");
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
            .sockets()
            .find(
                ({ identity, socket }) =>
                    identity.role === "daemon" && socket.isOpen() && this.#cx.services.connections.isCurrent(identity),
            );

    readonly registerSessionSubscription = async (
        computerId: string,
        target: NativeSessionTarget,
        routing: SessionEventsSubscribeCommandRouting,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (!sameNativeSession(routing.target, target)) {
            throw new PairingDirectoryError("invalid_request", "The subscription does not match its Session");
        }
        const daemon = this.currentDaemon();
        if (daemon === undefined || daemon.identity.computerId !== computerId) {
            throw new PairingDirectoryError("computer_offline", "The Computer is offline");
        }
        signal.throwIfAborted();
        this.relay(computerId).forwardSessionSubscription(daemon.socket, routing);
    };

    /** The public HTTP handler already authorized this local operation. */
    readonly receiveOperation = async (
        computerId: string,
        socket: ComputerOperationSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const silent = this.closeSilentDaemons();
        try {
            const daemon = this.currentDaemon();
            if (daemon !== undefined && daemon.identity.computerId !== computerId) {
                throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
            }
            const relay = this.relay(computerId);
            if (typeof message === "string") {
                await relay.receiveOperationMessage(socket, message, signal);
            } else {
                relay.receiveOperationChunk(socket, message);
            }
        } finally {
            await this.detachDaemons(silent);
        }
    };

    readonly cancelRequest = (
        computerId: string,
        operation: ComputerOperationSocket,
        requestId: string,
        signal: AbortSignal,
    ): void => {
        const daemon = this.requestControlDaemon(computerId, operation, requestId, signal);
        if (daemon !== null) {
            this.relay(computerId).forwardRequestCancellation(daemon, requestId);
        }
    };

    readonly grantFileCredit = (
        computerId: string,
        operation: ComputerOperationSocket,
        requestId: string,
        signal: AbortSignal,
    ): void => {
        if (operation.requestTransferKind() !== "file-read") {
            throw new PairingDirectoryError("invalid_request", "The credit does not own a file read");
        }
        const daemon = this.requestControlDaemon(computerId, operation, requestId, signal);
        if (daemon === null) {
            throw new PairingDirectoryError("computer_offline", "The Computer connection closed");
        }
        this.relay(computerId).forwardFileCredit(daemon, requestId);
    };

    private readonly requestControlDaemon = (
        computerId: string,
        operation: ComputerOperationSocket,
        requestId: string,
        signal: AbortSignal,
    ): RelaySocket | null => {
        signal.throwIfAborted();
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
        if (daemon === undefined || daemon.identity.computerId !== computerId || !daemon.socket.isSame(original)) {
            return null;
        }
        signal.throwIfAborted();
        return daemon.socket;
    };

    readonly receiveMessage = async (
        identity: ComputerSocketIdentity,
        socket: ComputerSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const computerId = identity.computerId;
        if (identity.role === "viewer") {
            const silentDaemons = this.closeSilentDaemons();
            try {
                socket.close(1008, "A live subscription cannot send commands");
                return;
            } finally {
                await this.detachDaemons(silentDaemons);
            }
        }
        if (typeof message !== "string") {
            try {
                await this.#daemonMessages.run(["runtime"], signal, async () => {
                    signal.throwIfAborted();
                    if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                        return;
                    }
                    this.relay(computerId).receiveDaemonChunk(message);
                });
            } catch (error) {
                signal.throwIfAborted();
                socket.close(
                    error instanceof ComputerMessageSchedulerCapacityError ? 1013 : 1008,
                    "Invalid content chunk",
                );
            }
            return;
        }
        if (
            message.length > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES ||
            new TextEncoder().encode(message).byteLength > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES
        ) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        let daemonMessage: DaemonToRelayMessage | null;
        try {
            daemonMessage = decodeDaemonToRelayMessage(message);
        } catch {
            // Reject this frame without disconnecting unrelated Sessions.
            this.relay(computerId).recordSkipped("invalid_daemon_message");
            return;
        }
        const lanes = daemonMessage === null ? ["runtime"] : this.daemonMessageLanes(daemonMessage);
        try {
            await this.#daemonMessages.run(lanes, signal, async () => {
                signal.throwIfAborted();
                if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                    return;
                }
                const relay = this.relay(computerId);
                await relay.receiveDaemonMessage(socket, daemonMessage, signal, message);
            });
        } catch (error) {
            if (error instanceof ComputerMessageSchedulerCapacityError) {
                logger.warn(
                    { ...identity, err: error, event: "computer_message_queue_full", closeCode: 1013 },
                    "Computer message queue full",
                );
                socket.close(1013, error.code);
                return;
            }
            throw error;
        }
    };

    private readonly authorizeDaemonMessage = async (
        identity: DaemonSocketIdentity,
        socket: ComputerSocket,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        // Disconnect delivery can fail after revocation commits in Computer storage, and the Computer can stop being
        // served. Read that authority before every business message; the local connection fence alone is insufficient.
        try {
            if ((await this.#cx.services.credentials.activeGeneration(identity, signal)) === null) {
                socket.close(1008, "Computer revoked");
                return false;
            }
        } catch (error) {
            signal.throwIfAborted();
            logger.warn(
                { ...identity, err: error, event: "computer_authorization_failed", closeCode: 1011 },
                "Computer authorization unavailable",
            );
            socket.close(1011, "Computer authorization unavailable");
            return false;
        }
        // A replacement may have been accepted while the authoritative lookup was in flight.
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        return socket.isOpen();
    };

    /**
     * Closes a daemon connection that is no longer the current one, telling a replaced daemon to reconnect and the
     * daemon of an ended generation that its Computer was revoked. True when it closed the connection.
     */
    private readonly fenceDaemon = (identity: ComputerConnectionIdentity, socket: ComputerSocket): boolean => {
        const standing = this.#cx.services.connections.standing(identity);
        switch (standing) {
            case "current":
                return false;
            case "replaced":
                socket.close(1012, "Daemon connection replaced");
                return true;
            case "ended":
                socket.close(1008, "Computer revoked");
                return true;
            default:
                return standing satisfies never;
        }
    };

    /**
     * Each event batch declares one Session. Its public target selects the ordering lane without reading events.
     */
    private readonly daemonMessageLanes = (message: DaemonToRelayMessage): readonly string[] => {
        if (message.kind === SESSION_EVENT_KIND) {
            return [`session:${nativeSessionKey(message.target)}`];
        }
        return ["runtime"];
    };

    private readonly relay = (computerId: string): ComputerRelayActor => {
        if (this.#channel === undefined) {
            this.#channel = { computerId, actor: this.#cx.services.relay(computerId) };
        }
        if (this.#channel.computerId !== computerId) {
            throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
        }
        return this.#channel.actor;
    };

    /** A viewer left: the Computer's daemon, if one is connected, stops delivering that subscription. */
    readonly detachViewer = (identity: SessionViewerIdentity): void => {
        const daemon = this.currentDaemon();
        if (daemon === undefined || daemon.identity.computerId !== identity.computerId) {
            return;
        }
        try {
            this.relay(identity.computerId).forwardSessionUnsubscribe(
                daemon.socket,
                identity.subscriptionId,
                identity.sessionFilter,
            );
        } catch (error) {
            logger.warn(
                { err: error, event: "session_subscription_cleanup_failed" },
                "Session subscription cleanup failed",
            );
        }
    };

    readonly detach = async (
        identity: ComputerSocketIdentity,
        socket: RelaySocket,
        signal: AbortSignal,
    ): Promise<void> => {
        if (identity.role === "viewer") {
            this.detachViewer(identity);
            return;
        }
        // The latest connection detaches once it closes, also after its generation ended: what was sent into it
        // must still be released.
        const latest = () =>
            identity.role === "daemon" && this.#cx.services.connections.standing(identity) !== "replaced";
        if (identity.role !== "daemon" || !latest()) {
            return;
        }
        for (const attachment of this.#attachments) {
            if (
                attachment.identity.computerId === identity.computerId &&
                attachment.identity.connectionEpoch === identity.connectionEpoch
            ) {
                attachment.controller.abort(new DOMException("Computer connection closed", "AbortError"));
            }
        }
        await this.#daemonMessages.idle(signal);
        if (!latest()) {
            return;
        }
        this.#cx.services.connections.disconnected(identity.connectionEpoch, Date.now());
        await this.relay(identity.computerId).detachDaemon(socket);
    };

    private readonly closeSilentDaemons = (): readonly ComputerPeer[] => {
        const now = Date.now();
        const silent: ComputerPeer[] = [];
        for (const { identity, socket, heartbeat } of this.#cx.gateways.peers.daemonConnections()) {
            if (identity.role !== "daemon" || !socket.isOpen()) {
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
            logger.warn(
                {
                    ...identity,
                    closeCode: 4001,
                    event: "computer_heartbeat_silence",
                    silenceMilliseconds: now - heardAt,
                },
                "Computer daemon stopped heartbeating",
            );
            socket.close(4001, "Computer heartbeat timed out");
            silent.push({ identity, socket });
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
    private readonly detachDaemons = async (daemons: readonly ComputerPeer[]): Promise<void> => {
        for (const { identity, socket } of daemons) {
            const timeout = new AbortController();
            const timer = setTimeout(
                () => timeout.abort(new DOMException("The Computer detach timed out", "TimeoutError")),
                DAEMON_DETACH_TIMEOUT_MILLISECONDS,
            );
            try {
                await this.detach(identity, socket, timeout.signal);
            } finally {
                clearTimeout(timer);
            }
        }
    };

    private readonly notifyOffline = (): void => {
        for (const { socket } of this.#cx.gateways.peers.operations()) {
            socket.computerOffline();
        }
    };
}
