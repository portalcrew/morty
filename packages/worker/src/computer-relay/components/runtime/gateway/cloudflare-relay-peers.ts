import * as v from "valibot";
import type { ComputerConnectionIdentity } from "../entity/computer-connection.ts";
import type { RelaySocket } from "../service/computer-relay-actor.ts";
import type { ComputerPeers, DaemonHeartbeat } from "../service/computer-service.ts";

// A hibernated Durable Object has no request to learn its Computer from; its sockets' attachments are the one place
// that survives, and the object checks the id they name against its own before serving it.
const attachmentSchema = v.object({
    connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    computerId: v.string(),
});

export function daemonSocketComputerId(socket: WebSocket): string {
    return v.parse(attachmentSchema, socket.deserializeAttachment()).computerId;
}

export class CloudflareRelaySocket implements RelaySocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    readonly identity = (): ComputerConnectionIdentity => {
        const { connectionEpoch } = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        return { connectionEpoch };
    };

    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: RelaySocket): boolean =>
        socket instanceof CloudflareRelaySocket && socket.#socket === this.#socket;
    readonly send = (message: string | ArrayBuffer): void => this.#socket.send(message);
}

export class CloudflareRelayPeers implements Omit<ComputerPeers, "operations" | "daemons" | "viewers"> {
    readonly #state: DurableObjectState;
    readonly #computerId: string;

    constructor(state: DurableObjectState, computerId: string) {
        this.#state = state;
        this.#computerId = computerId;
    }

    readonly daemonConnections: ComputerPeers["daemonConnections"] = () =>
        this.#state.getWebSockets("daemon").map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            const answeredAt = this.#state.getWebSocketAutoResponseTimestamp(webSocket)?.getTime();
            const heartbeat: DaemonHeartbeat =
                answeredAt === undefined ? { kind: "none" } : { kind: "received", at: answeredAt };
            return { heartbeat, identity: socket.identity(), socket };
        });

    readonly accept: ComputerPeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment({ ...identity, computerId: this.#computerId });
        this.#state.acceptWebSocket(server, ["daemon"]);
        return {
            socket: new CloudflareRelaySocket(server),
            response: new Response(null, { status: 101, webSocket: pair[0] }),
        };
    };
}
