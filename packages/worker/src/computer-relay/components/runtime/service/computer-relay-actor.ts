import { sameNativeSession } from "@morty-build/client/native-session";
import {
    type AGENT_SETTINGS_DISCOVER_KIND,
    type ClientToRelayMessage,
    COMPUTER_STATUS_KIND,
    contentChunkCodec,
    type DaemonToRelayMessage,
    decodeClientToRelayMessage,
    ENCRYPTED_MESSAGE_MAX_WIRE_BYTES,
    encodeComputerStatusEvent,
    encodeSessionEventsUnsubscribe,
    encodeWorkerFileCredit,
    encodeWorkerRequestCancel,
    encodeWorkerRequestRejected,
    type NativeSessionCommandRouting,
    type NativeSessionTarget,
    ProtocolMessageError,
    SESSION_EVENTS_SUBSCRIBE_KIND,
    type SESSION_HISTORY_PAGE_LOAD_KIND,
    type SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    type SessionEventsSubscribeCommandRouting,
    sessionEventsSubscribeCommandCodec,
    WORKER_REQUEST_REJECTED_KIND,
} from "@morty-build/client/protocol";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { logger } from "../../../../infra/logger.ts";
import { SessionLiveEventRelay } from "./session-live-event-relay.ts";

type OperationRouting = Exclude<ClientToRelayMessage, { readonly kind: typeof SESSION_EVENTS_SUBSCRIBE_KIND }>;

function operationAddress(command: OperationRouting): string {
    return command.requestId;
}

function daemonHandler<K extends DaemonToRelayMessage["kind"]>(
    kind: K,
    handle: (message: Extract<DaemonToRelayMessage, { readonly kind: K }>, encoded: string) => void,
): (message: DaemonToRelayMessage, encoded: string) => void {
    return (message, encoded) => {
        if (!isDaemonKind(message, kind)) {
            throw new ProtocolMessageError("Daemon message does not match its handler");
        }
        handle(message, encoded);
    };
}

function isDaemonKind<K extends DaemonToRelayMessage["kind"]>(
    message: DaemonToRelayMessage,
    kind: K,
): message is Extract<DaemonToRelayMessage, { readonly kind: K }> {
    return message.kind === kind;
}

function clientHandler<K extends ClientToRelayMessage["kind"]>(
    kind: K,
    handle: (
        socket: ComputerOperationSocket,
        message: Extract<ClientToRelayMessage, { readonly kind: K }>,
        encoded: string,
    ) => void,
): (socket: ComputerOperationSocket, message: ClientToRelayMessage, encoded: string) => void {
    return (socket, message, encoded) => {
        if (!isClientKind(message, kind)) {
            throw new ProtocolMessageError("Client message does not match its handler");
        }
        handle(socket, message, encoded);
    };
}

function isClientKind<K extends ClientToRelayMessage["kind"]>(
    message: ClientToRelayMessage,
    kind: K,
): message is Extract<ClientToRelayMessage, { readonly kind: K }> {
    return message.kind === kind;
}

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1013 {
    if (error.code === "session_busy") {
        return 1013;
    }
    return 1008;
}

function copyBinaryFrame(value: unknown): ArrayBuffer {
    if (value instanceof ArrayBuffer) {
        return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
        // Copy the view's bytes: its buffer may be shared or larger than the view.
        const copy = new ArrayBuffer(value.byteLength);
        new Uint8Array(copy).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        return copy;
    }
    throw new ProtocolMessageError("Content chunk must be binary");
}

function knownChunk(value: unknown, skipped: () => void) {
    try {
        return contentChunkCodec.decodeRouting(value);
    } catch {
        skipped();
        return null;
    }
}

export type HistoryRequestKind = "live" | "preview";

export interface RelaySocket {
    readonly close: (code: number, reason: string) => void;
    readonly isOpen: () => boolean;
    readonly isSame: (socket: RelaySocket) => boolean;
    readonly send: (message: string | ArrayBuffer) => void;
}

export interface ComputerOperationSocket extends RelaySocket {
    readonly recordRequestDaemon: (daemon: RelaySocket, action: NativeSessionCommandRouting["action"]) => void;
    readonly recordTransferDaemon: (daemon: RelaySocket, kind: "file-read" | "content-write") => void;
    readonly requestTransferKind: () => "file-read" | "content-write" | null;
    readonly requestDaemon: () => RelaySocket | null;
    readonly requestAction: () => NativeSessionCommandRouting["action"] | null;
    readonly consumeAgentSettingsDiscovery: (requestId: string, harness: string) => boolean;
    readonly consumeAgentSettingsDiscoveryFailure: (requestId: string) => boolean;
    readonly takeAgentSettingsDiscoveries: () => readonly string[];
    readonly bindHistoryRequest: (kind: HistoryRequestKind, requestId: string) => void;
    readonly matchesHistoryRequest: (kind: HistoryRequestKind, requestId: string) => boolean;
    readonly trackAgentSettingsDiscovery: (requestId: string, harness: string) => "tracked" | "duplicate" | "busy";
}

export interface RelayPeers {
    readonly viewers: () => readonly {
        readonly socket: RelaySocket;
        readonly target: NativeSessionTarget;
        readonly expiresAt: number;
    }[];
    readonly operations: () => readonly {
        readonly socket: ComputerOperationSocket;
        readonly requestId: string;
        readonly target: NativeSessionTarget | undefined;
    }[];
    readonly daemons: () => readonly RelaySocket[];
}

export class ComputerRelayActor {
    #lastSkippedLogAt = Number.NEGATIVE_INFINITY;
    #skippedCount = 0;

    readonly recordSkipped = (reason: string): void => {
        this.#skippedCount += 1;
        const now = Date.now();
        if (now - this.#lastSkippedLogAt < 60_000) {
            return;
        }
        logger.warn(
            {
                event: "relay_message_skipped",
                reason,
                skippedCount: this.#skippedCount,
                computerId: this.#computerId,
            },
            "Relay skipped unsupported input",
        );
        this.#lastSkippedLogAt = now;
        this.#skippedCount = 0;
    };
    readonly #peers: RelayPeers;
    readonly #computerId: string;
    readonly #liveEvents: SessionLiveEventRelay;

    private readonly clientOperation = <K extends OperationRouting["kind"]>(kind: K) =>
        clientHandler(kind, (socket, command, encoded) => this.forwardControl(socket, command, encoded));

    readonly #clientHandlers = {
        "agent.settings.discover": clientHandler("agent.settings.discover", (socket, command, encoded) =>
            this.forwardAgentSettingsDiscovery(socket, command, encoded),
        ),
        "session.live-history.v2.page.load": clientHandler(
            "session.live-history.v2.page.load",
            (socket, command, encoded) => this.forwardHistoryPage(socket, "live", command, encoded),
        ),
        "session.preview-history.page.load": clientHandler(
            "session.preview-history.page.load",
            (socket, command, encoded) => this.forwardHistoryPage(socket, "preview", command, encoded),
        ),
        "session.events.subscribe": clientHandler("session.events.subscribe", () => {
            throw new ProtocolMessageError("Subscription requires an authorized viewer");
        }),
        "file.read": this.clientOperation("file.read"),
        "content.write": this.clientOperation("content.write"),
        "content.commit": this.clientOperation("content.commit"),
        "session.list": this.clientOperation("session.list"),
        "session.query": this.clientOperation("session.query"),
        "session.restore": this.clientOperation("session.restore"),
        "session.archive": this.clientOperation("session.archive"),
        "native.session.cancel": this.clientOperation("native.session.cancel"),
        "native.session.request": clientHandler("native.session.request", (socket, command, encoded) =>
            this.forwardNativeRequest(socket, command, encoded),
        ),
        "computer.diagnostics.read": this.clientOperation("computer.diagnostics.read"),
        "computer.ping": this.clientOperation("computer.ping"),
        "session.cancel-before-start": this.clientOperation("session.cancel-before-start"),
        "session.cancel": this.clientOperation("session.cancel"),
        "session.configure": this.clientOperation("session.configure"),
        "session.config.read": this.clientOperation("session.config.read"),
        "session.rename": this.clientOperation("session.rename"),
        "session.elicitation.respond": this.clientOperation("session.elicitation.respond"),
        "session.permission.respond": this.clientOperation("session.permission.respond"),
        "session.create": this.clientOperation("session.create"),
        "session.prepare": this.clientOperation("session.prepare"),
        "session.prompt": this.clientOperation("session.prompt"),
        "session.prompt.disposition": this.clientOperation("session.prompt.disposition"),
        "workspace.list": this.clientOperation("workspace.list"),
    } satisfies {
        readonly [K in ClientToRelayMessage["kind"]]: (
            socket: ComputerOperationSocket,
            message: ClientToRelayMessage,
            encoded: string,
        ) => void;
    };

    private readonly addressedDaemon = <
        K extends Extract<DaemonToRelayMessage, { readonly requestId: string }>["kind"],
    >(
        kind: K,
    ) => daemonHandler(kind, (message, encoded) => this.returnAddressed(message, encoded));

    readonly #daemonHandlers = {
        "session.event.v2": daemonHandler("session.event.v2", (message, encoded) =>
            this.#liveEvents.receive(message, encoded),
        ),
        "session.close.notice": daemonHandler("session.close.notice", (message, encoded) => {
            this.broadcast(
                this.#peers
                    .viewers()
                    .filter(
                        (viewer) => viewer.expiresAt > Date.now() && sameNativeSession(viewer.target, message.target),
                    )
                    .map((viewer) => viewer.socket),
                encoded,
            );
        }),
        "agent.settings.discovered": daemonHandler("agent.settings.discovered", (message, encoded) =>
            this.returnAgentSettingsDiscoveryResult(message.requestId, message.harness, encoded),
        ),
        "agent.settings.discovery.failed": daemonHandler("agent.settings.discovery.failed", (message, encoded) =>
            this.returnAgentSettingsDiscoveryFailure(message.requestId, encoded),
        ),
        "session.live-history.v2.page.loaded": daemonHandler(
            "session.live-history.v2.page.loaded",
            (message, encoded) => this.returnHistoryPage("live", message.requestId, message.target, encoded),
        ),
        "session.preview-history.page.loaded": daemonHandler(
            "session.preview-history.page.loaded",
            (message, encoded) => this.returnHistoryPage("preview", message.requestId, message.target, encoded),
        ),
        "computer.heartbeat": daemonHandler("computer.heartbeat", () => {}),
        "session.archived": this.addressedDaemon("session.archived"),
        "session.config.updated": this.addressedDaemon("session.config.updated"),
        "session.config.read.result": this.addressedDaemon("session.config.read.result"),
        "session.renamed": this.addressedDaemon("session.renamed"),
        "file.begin": this.addressedDaemon("file.begin"),
        "file.end": this.addressedDaemon("file.end"),
        "file.failed": this.addressedDaemon("file.failed"),
        "content.ready": this.addressedDaemon("content.ready"),
        "content.chunk.ack": daemonHandler("content.chunk.ack", () => {}),
        "content.available": this.addressedDaemon("content.available"),
        "session.listed": this.addressedDaemon("session.listed"),
        "session.queried": this.addressedDaemon("session.queried"),
        "session.restored": this.addressedDaemon("session.restored"),
        "native.session.result": daemonHandler("native.session.result", (message, encoded) => {
            if (message.action === "fork") {
                this.returnForkResult(message.requestId, message.target, encoded);
            } else {
                this.returnAddressed(message, encoded);
            }
        }),
        "computer.diagnostics.result": this.addressedDaemon("computer.diagnostics.result"),
        "computer.pong": this.addressedDaemon("computer.pong"),
        "session.operation.failed": this.addressedDaemon("session.operation.failed"),
        "session.prompt.accepted": this.addressedDaemon("session.prompt.accepted"),
        "session.prompt.steered": this.addressedDaemon("session.prompt.steered"),
        "session.turn.stopped": this.addressedDaemon("session.turn.stopped"),
        "session.turn.withdrawn": this.addressedDaemon("session.turn.withdrawn"),
        "session.interaction.answered": this.addressedDaemon("session.interaction.answered"),
        "session.ready": this.addressedDaemon("session.ready"),
        "workspace.entries": this.addressedDaemon("workspace.entries"),
    } satisfies {
        readonly [K in DaemonToRelayMessage["kind"]]: (message: DaemonToRelayMessage, encoded: string) => void;
    };

    constructor(cx: {
        readonly config: { readonly computerId: string };
        readonly gateways: {
            readonly peers: RelayPeers;
        };
    }) {
        const { computerId } = cx.config;
        const { peers } = cx.gateways;
        this.#peers = peers;
        this.#computerId = computerId;
        this.#liveEvents = new SessionLiveEventRelay(peers);
    }

    readonly attachDaemon = async (replacedExistingConnection: boolean, _signal: AbortSignal): Promise<void> => {
        if (replacedExistingConnection) {
            this.failPendingAgentSettingsDiscoveries();
            // The new daemon has no live subscription registry. Clients must
            // establish fresh encrypted subscriptions themselves.
            for (const { socket } of this.#peers.viewers()) {
                socket.close(1012, "Daemon connection replaced");
            }
        }
        this.broadcastComputerStatus(true);
    };

    readonly failTransfersOwnedBy = (daemon: RelaySocket): void => {
        for (const route of this.#peers.operations()) {
            if (route.socket.requestTransferKind() !== null && route.socket.requestDaemon()?.isSame(daemon)) {
                this.refuseOffline(route.socket, route.requestId);
            }
        }
    };

    readonly detachDaemon = async (socket: RelaySocket, _signal: AbortSignal): Promise<void> => {
        const anotherDaemonOnline = this.#peers
            .daemons()
            .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
        if (anotherDaemonOnline) {
            return;
        }
        this.failPendingAgentSettingsDiscoveries();
        this.broadcastComputerStatus(false);
    };

    readonly forwardSessionSubscription = (
        daemon: RelaySocket,
        routing: SessionEventsSubscribeCommandRouting,
    ): void => {
        daemon.send(sessionEventsSubscribeCommandCodec.encodeRouting(routing));
    };

    readonly forwardSessionUnsubscribe = (
        daemon: RelaySocket,
        subscriptionId: string,
        target: NativeSessionTarget,
    ): void => {
        daemon.send(encodeSessionEventsUnsubscribe({ kind: "session.events.unsubscribe", subscriptionId, target }));
    };

    readonly forwardRequestCancellation = (daemon: RelaySocket, requestId: string): void => {
        daemon.send(encodeWorkerRequestCancel({ kind: "worker.request.cancel", requestId }));
    };

    readonly forwardFileCredit = (daemon: RelaySocket, requestId: string): void => {
        daemon.send(encodeWorkerFileCredit({ kind: "worker.file.credit", requestId, chunks: 1 }));
    };

    readonly receiveDaemonMessage = async (
        socket: RelaySocket,
        message: DaemonToRelayMessage | null,
        signal: AbortSignal,
        encoded?: string,
    ): Promise<void> => {
        try {
            if (message === null) {
                this.recordSkipped("unsupported_daemon_message");
                return;
            }
            if (encoded === undefined) {
                this.recordSkipped("missing_daemon_payload");
                return;
            }
            if (message.kind === "content.chunk.ack") {
                const route = this.#peers.operations().find((candidate) => candidate.requestId === message.requestId);
                if (
                    route !== undefined &&
                    route.socket.requestTransferKind() === "content-write" &&
                    route.socket.requestDaemon()?.isSame(socket)
                ) {
                    route.socket.send(encoded);
                }
                return;
            }
            this.#daemonHandlers[message.kind](message, encoded);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(
                error instanceof ProtocolMessageError ? 1008 : 1011,
                error instanceof ProtocolMessageError ? "Invalid protocol message" : "Session storage unavailable",
            );
        }
    };

    readonly receiveDaemonChunk = (_socket: RelaySocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_daemon_frame"));
        if (chunk === null) {
            return;
        }
        const recipient = this.#peers
            .operations()
            .find((route) => route.requestId === chunk.requestId && route.socket.isOpen())?.socket;
        if (recipient === undefined) {
            // The HTTP caller can cancel after the daemon has already queued its next
            // chunk. The operation route is gone by the time that frame arrives, but
            // this is not a daemon protocol violation and must not interrupt unrelated
            // Sessions sharing the Computer connection.
            return;
        }
        recipient.send(copyBinaryFrame(message));
    };

    readonly receiveOperationChunk = (socket: ComputerOperationSocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_operation_frame"));
        if (chunk === null) {
            return;
        }
        const ownsOperation = this.#peers
            .operations()
            .some((route) => route.requestId === chunk.requestId && route.socket.isSame(socket));
        if (!ownsOperation) {
            throw new ProtocolMessageError("Content chunk does not belong to this operation");
        }
        if (socket.requestTransferKind() !== "content-write") {
            throw new ProtocolMessageError("Content chunk does not belong to an upload");
        }
        const original = socket.requestDaemon();
        const daemon = this.#peers.daemons().find((candidate) => candidate.isOpen() && original?.isSame(candidate));
        if (daemon === undefined) {
            throw new SessionRuntimeError("computer_offline", "The local computer is offline");
        }
        daemon.send(copyBinaryFrame(message));
    };

    readonly receiveOperationMessage = async (
        socket: ComputerOperationSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        if (
            typeof message !== "string" ||
            message.length > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES ||
            new TextEncoder().encode(message).byteLength > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES
        ) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        try {
            const command = decodeClientToRelayMessage(message);
            if (command.kind !== SESSION_EVENTS_SUBSCRIBE_KIND) {
                const requestId = operationAddress(command);
                const ownsOperation = this.#peers
                    .operations()
                    .some(
                        (route) =>
                            route.socket.isSame(socket) &&
                            route.requestId === requestId &&
                            (route.target === undefined ||
                                command.kind === "native.session.cancel" ||
                                ("target" in command && sameNativeSession(route.target, command.target))),
                    );
                if (!ownsOperation) {
                    throw new ProtocolMessageError("The command does not belong to this operation");
                }
            }
            this.#clientHandlers[command.kind](socket, command, message);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(1008, "Invalid protocol message");
        }
    };

    /** Sends one authorized operation to the daemon. */
    private readonly forwardControl = (
        socket: ComputerOperationSocket,
        command: OperationRouting,
        encoded: string,
    ): void => {
        if (command.kind === "content.commit") {
            const original = socket.requestDaemon();
            const daemon = this.#peers.daemons().find((candidate) => candidate.isOpen() && original?.isSame(candidate));
            if (socket.requestTransferKind() !== "content-write" || daemon === undefined) {
                this.refuseOffline(socket, command.requestId);
            } else {
                daemon.send(encoded);
            }
            return;
        }
        const daemon = this.sendToDaemon(encoded);
        if (daemon === null) {
            this.refuseOffline(socket, operationAddress(command));
        } else if (command.kind === "content.write" || command.kind === "file.read") {
            socket.recordTransferDaemon(daemon, command.kind === "file.read" ? "file-read" : "content-write");
        }
    };

    private readonly forwardNativeRequest = (
        socket: ComputerOperationSocket,
        command: Extract<ClientToRelayMessage, { readonly kind: "native.session.request" }>,
        encoded: string,
    ): void => {
        const daemon = this.sendToDaemon(encoded);
        if (daemon === null) {
            this.refuseOffline(socket, command.requestId);
            return;
        }
        socket.recordRequestDaemon(daemon, command.action);
    };

    /** Refuses only this request; other operations on the connection remain usable. */
    private readonly refuseOffline = (socket: RelaySocket, requestId: string): void => {
        socket.send(
            encodeWorkerRequestRejected({
                code: "computer_offline",
                kind: WORKER_REQUEST_REJECTED_KIND,
                message: "The local computer is offline",
                requestId,
            }),
        );
    };

    private readonly forwardAgentSettingsDiscovery = (
        socket: ComputerOperationSocket,
        command: Extract<ClientToRelayMessage, { readonly kind: typeof AGENT_SETTINGS_DISCOVER_KIND }>,
        encoded: string,
    ): void => {
        const { harness } = command;
        const requestId = command.requestId;
        const route = socket.trackAgentSettingsDiscovery(requestId, harness);
        if (route === "duplicate") {
            return;
        }
        if (route === "busy") {
            socket.send(
                encodeWorkerRequestRejected({
                    code: "agent_settings_discovery_busy",
                    kind: WORKER_REQUEST_REJECTED_KIND,
                    message: "This connection already has pending settings discovery requests",
                    requestId,
                }),
            );
            return;
        }
        if (this.sendToDaemon(encoded) === null) {
            socket.consumeAgentSettingsDiscoveryFailure(requestId);
            socket.send(
                encodeWorkerRequestRejected({
                    code: "computer_offline",
                    kind: WORKER_REQUEST_REJECTED_KIND,
                    message: "The local computer is offline",
                    requestId,
                }),
            );
            return;
        }
    };

    private readonly returnAddressed = (
        message: Extract<DaemonToRelayMessage, { readonly requestId: string }>,
        encoded: string,
    ): void => {
        this.broadcast(
            this.#peers
                .operations()
                .filter(
                    (route) =>
                        route.requestId === message.requestId &&
                        (!("target" in message) ||
                            message.target === undefined ||
                            route.target === undefined ||
                            sameNativeSession(route.target, message.target)),
                )
                .map((route) => route.socket),
            encoded,
        );
    };

    private readonly returnForkResult = (requestId: string, target: NativeSessionTarget, encoded: string): void => {
        // A Fork answers with a new Session, not the authorized source Session.
        this.broadcast(
            this.#peers
                .operations()
                .filter(
                    (route) =>
                        route.requestId === requestId &&
                        route.socket.requestAction() === "fork" &&
                        route.target !== undefined &&
                        route.target.harness === target.harness &&
                        !sameNativeSession(route.target, target),
                )
                .map((route) => route.socket),
            encoded,
        );
    };

    private readonly returnAgentSettingsDiscoveryResult = (
        requestId: string,
        harness: string,
        message: string,
    ): void => {
        const recipient = this.#peers
            .operations()
            .map(({ socket }) => socket)
            .find((socket) => socket.consumeAgentSettingsDiscovery(requestId, harness));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnAgentSettingsDiscoveryFailure = (requestId: string, message: string): void => {
        const recipient = this.#peers
            .operations()
            .map(({ socket }) => socket)
            .find((socket) => socket.consumeAgentSettingsDiscoveryFailure(requestId));
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnHistoryPage = (
        kind: HistoryRequestKind,
        requestId: string,
        target: NativeSessionTarget,
        encoded: string,
    ): void => {
        const recipient = this.#peers
            .operations()
            .find(
                (route) =>
                    route.socket.isOpen() &&
                    route.socket.matchesHistoryRequest(kind, requestId) &&
                    (route.target === undefined || sameNativeSession(route.target, target)),
            )?.socket;
        // A caller can close or time out independently of the authenticated daemon.
        recipient?.send(encoded);
    };

    private readonly forwardHistoryPage = (
        socket: ComputerOperationSocket,
        kind: HistoryRequestKind,
        command: Extract<
            ClientToRelayMessage,
            {
                readonly kind: typeof SESSION_HISTORY_PAGE_LOAD_KIND | typeof SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND;
            }
        >,
        encoded: string,
    ): void => {
        // A local history route belongs to one operation and ends with that caller.
        socket.bindHistoryRequest(kind, command.requestId);
        if (this.sendToDaemon(encoded) === null) {
            socket.close(1013, "Computer offline");
        }
    };

    private readonly failPendingAgentSettingsDiscoveries = (): void => {
        for (const socket of this.#peers.operations().map(({ socket }) => socket)) {
            for (const requestId of socket.takeAgentSettingsDiscoveries()) {
                if (socket.isOpen()) {
                    socket.send(
                        encodeWorkerRequestRejected({
                            code: "computer_offline",
                            kind: WORKER_REQUEST_REJECTED_KIND,
                            message: "The local computer is offline",
                            requestId,
                        }),
                    );
                }
            }
        }
    };

    private readonly sendToDaemon = (encoded: string): RelaySocket | null => {
        const daemon = this.#peers.daemons().find((socket) => socket.isOpen());
        if (daemon === undefined) {
            return null;
        }
        try {
            daemon.send(encoded);
            return daemon;
        } catch {
            return null;
        }
    };

    private readonly broadcastComputerStatus = (online: boolean): void => {
        if (!online) {
            for (const { socket } of this.#peers.viewers()) {
                socket.close(1000, "Computer offline");
            }
        }
        this.broadcast(
            this.#peers.operations().map(({ socket }) => socket),
            encodeComputerStatusEvent({ kind: COMPUTER_STATUS_KIND, online, computerId: this.#computerId }),
        );
    };

    private readonly broadcast = (sockets: readonly RelaySocket[], message: string): void => {
        for (const socket of sockets) {
            if (socket.isOpen()) {
                socket.send(message);
            }
        }
    };
}
