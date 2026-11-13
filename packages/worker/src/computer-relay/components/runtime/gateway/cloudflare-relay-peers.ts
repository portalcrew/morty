import { decodeSessionAccessGrant, isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";
import type { RelaySocket } from "../service/computer-relay-actor.ts";
import type {
    ComputerPeers,
    ComputerSocket,
    ComputerSocketIdentity,
    DaemonHeartbeat,
} from "../service/computer-service.ts";

const targetSchema = v.object({
    harness: v.pipe(
        v.string(),
        v.check((value: string) => isIdentifier(value)),
    ),
    sessionId: v.pipe(
        v.string(),
        v.check((value: string) => isIdentifier(value)),
    ),
});
const attachmentSchema = v.union([
    v.object({
        role: v.literal("viewer"),
        expiresAt: v.number(),
        credential: v.object({
            signingKeyId: v.string(),
            grant: v.pipe(v.unknown(), v.transform(decodeSessionAccessGrant)),
        }),
        computerId: v.string(),
        sessionFilter: targetSchema,
        subscriptionId: v.pipe(
            v.string(),
            v.check((value: string) => isIdentifier(value)),
        ),
    }),
    v.object({
        role: v.picklist(["daemon", "replaced-daemon"]),
        connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        computerId: v.string(),
    }),
]);

export class CloudflareRelaySocket implements ComputerSocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    readonly identity = (): ComputerSocketIdentity => v.parse(attachmentSchema, this.#socket.deserializeAttachment());

    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: RelaySocket): boolean =>
        socket instanceof CloudflareRelaySocket && socket.#socket === this.#socket;
    readonly send = (message: string | ArrayBuffer): void => this.#socket.send(message);
    readonly replaceDaemon = (): void => {
        const identity = this.identity();
        if (identity.role !== "daemon" && identity.role !== "replaced-daemon") {
            throw new Error("Only a daemon socket can replace a daemon");
        }
        this.#socket.serializeAttachment({ ...identity, role: "replaced-daemon" });
        this.#socket.close(1012, "Daemon connection replaced");
    };
}

export class CloudflareRelayPeers implements Omit<ComputerPeers, "operations"> {
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState) {
        this.#state = state;
    }

    readonly sockets = () =>
        this.#state.getWebSockets().map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            return { socket, identity: socket.identity() };
        });

    readonly daemonConnections: ComputerPeers["daemonConnections"] = () =>
        this.#state.getWebSockets("daemon").map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            const answeredAt = this.#state.getWebSocketAutoResponseTimestamp(webSocket)?.getTime();
            const heartbeat: DaemonHeartbeat =
                answeredAt === undefined ? { kind: "none" } : { kind: "received", at: answeredAt };
            return { heartbeat, identity: socket.identity(), socket };
        });

    readonly daemons = (): readonly RelaySocket[] =>
        this.sockets()
            .filter(({ identity }) => identity.role === "daemon")
            .map(({ socket }) => socket);

    readonly viewers = () =>
        this.sockets().flatMap(({ socket, identity }) =>
            identity.role === "viewer"
                ? [
                      {
                          socket,
                          target: identity.sessionFilter,
                          expiresAt: identity.expiresAt,
                      },
                  ]
                : [],
        );

    readonly accept: ComputerPeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment(identity);
        this.#state.acceptWebSocket(server, [identity.role]);
        return {
            socket: new CloudflareRelaySocket(server),
            response: new Response(null, { status: 101, webSocket: pair[0] }),
        };
    };
}
