import { CHANGES_CHANGED_KIND, CHANGES_ERROR_KIND, type RelayChangeTopic } from "@portalcrew/morty-client/protocol";
import * as v from "valibot";
import type { ChangeFollow } from "../../../../contracts/relay-changes.ts";
import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";
import {
    type BrowserTransport,
    type BrowserTransportPorts,
    MAX_SUBSCRIPTIONS_PER_CONNECTION,
    openBrowserTransport,
} from "../http/websocket-http-transport.ts";

const BROWSER_TAG = "browser";
// A browser heartbeats every 20 seconds; one silent this long has lost its connection.
const SILENCE_LIMIT_MILLISECONDS = 60_000;

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const holder = v.variant("kind", [
    v.object({ kind: v.literal("device"), deviceId: identifier }),
    v.object({ kind: v.literal("credential"), credentialId: identifier }),
]);

/**
 * What a browser connection must keep through hibernation: whose Computer it is, when it began, its viewers, and the
 * access it follows changes under.
 */
const attachmentSchema = v.object({
    computerId: identifier,
    acceptedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
    follow: v.nullable(
        v.object({ holder, accessExpiresAt: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))) }),
    ),
    subscriptions: v.pipe(
        v.array(
            v.object({
                subscriptionId: identifier,
                sessionFilter: v.object({ harness: identifier, sessionId: identifier }),
                expiresAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
                grant: v.object({
                    holder,
                    generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
                }),
            }),
        ),
        v.maxLength(MAX_SUBSCRIPTIONS_PER_CONNECTION),
    ),
});

interface BrowserAttachment {
    readonly computerId: string;
    readonly acceptedAt: number;
    readonly follow: ChangeFollow | null;
    readonly subscriptions: readonly SessionViewerIdentity[];
}

/**
 * The browser connections of one Relay, accepted through the Hibernation API so an idle Relay can hibernate and adopt
 * new code without dropping them. The socket attachment is the only record of a connection; the transports here are
 * its in-memory workers and are reopened from it after the Relay wakes.
 */
export class CloudflareBrowserTransports {
    readonly #state: DurableObjectState;
    readonly #ports: BrowserTransportPorts;
    readonly #wake: (computerId: string) => void;
    readonly #followsChanged: () => Promise<void>;
    readonly #open = new Map<WebSocket, BrowserTransport>();

    /**
     * `wake` prepares the Relay for `computerId`, reopening every connection it forgot through `restore`;
     * `followsChanged` lets the Relay schedule the checks the followed changes need.
     */
    constructor(
        state: DurableObjectState,
        ports: BrowserTransportPorts,
        wake: (computerId: string) => void,
        followsChanged: () => Promise<void>,
    ) {
        this.#state = state;
        this.#ports = ports;
        this.#wake = wake;
        this.#followsChanged = followsChanged;
    }

    readonly accept = (request: Request, computerId: string): Response => {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return Response.json(
                { error: { code: "websocket_upgrade_required", message: "A WebSocket upgrade is required" } },
                { status: 426 },
            );
        }
        const pair = new WebSocketPair();
        const server = pair[1];
        const attachment: BrowserAttachment = { computerId, acceptedAt: Date.now(), follow: null, subscriptions: [] };
        server.serializeAttachment(attachment);
        this.#state.acceptWebSocket(server, [BROWSER_TAG]);
        this.#open.set(server, this.#openTransport(server, attachment));
        return new Response(null, { status: 101, webSocket: pair[0] });
    };

    readonly owns = (socket: WebSocket): boolean => this.#state.getTags(socket).includes(BROWSER_TAG);

    readonly receive = async (socket: WebSocket, message: string | ArrayBuffer): Promise<void> => {
        await this.#transport(socket)?.receive(message);
    };

    readonly closed = (socket: WebSocket, code: number, reason: string): void => {
        this.#transport(socket)?.release();
        this.#open.delete(socket);
        socket.close(code, reason);
    };

    /** Reopens the connections this Relay holds but forgot when it hibernated. */
    readonly restore = (): void => {
        for (const socket of this.#state.getWebSockets(BROWSER_TAG)) {
            if (this.#open.has(socket)) {
                continue;
            }
            const attachment = readAttachment(socket);
            if (attachment === null) {
                socket.close(1011, "WebSocket transport state unavailable");
                continue;
            }
            this.#open.set(socket, this.#openTransport(socket, attachment));
        }
    };

    /** Wakes the Relay's memory of its connections when it holds any, so viewer checks see them. */
    readonly wake = (): void => {
        const socket = this.#state.getWebSockets(BROWSER_TAG)[0];
        if (socket !== undefined) {
            this.#transport(socket);
        }
    };

    readonly closeSilent = (now: number): void => {
        for (const socket of this.#openSockets()) {
            const heardAt = this.#heardAt(socket);
            if (heardAt !== null && now - heardAt > SILENCE_LIMIT_MILLISECONDS) {
                this.closed(socket, 1001, "WebSocket transport idle timeout");
            }
        }
    };

    /** When the earliest open connection falls silent, or null when none is open. */
    readonly nextSilenceCheck = (): number | null => {
        const due = this.#openSockets().flatMap((socket) => {
            const heardAt = this.#heardAt(socket);
            return heardAt === null ? [] : [heardAt + SILENCE_LIMIT_MILLISECONDS + 1];
        });
        return due.length === 0 ? null : Math.min(...due);
    };

    /** Tells every connection that follows changes that `topic` changed, so it reads it again. */
    readonly announce = (topic: RelayChangeTopic): void => {
        const notice = JSON.stringify({ kind: CHANGES_CHANGED_KIND, topic });
        for (const socket of this.#openSockets()) {
            if (readAttachment(socket)?.follow) {
                socket.send(notice);
            }
        }
    };

    /** The changes followed now: their connections' Computer and the access each follows under. */
    readonly follows = (): readonly { readonly computerId: string; readonly follow: ChangeFollow }[] =>
        this.#openSockets().flatMap((socket) => {
            const attachment = readAttachment(socket);
            return attachment?.follow ? [{ computerId: attachment.computerId, follow: attachment.follow }] : [];
        });

    /** Stops following changes for every connection whose access `ended`, telling it why. */
    readonly endFollows = async (
        ended: (computerId: string, follow: ChangeFollow) => Promise<boolean>,
    ): Promise<void> => {
        for (const socket of this.#openSockets()) {
            const attachment = readAttachment(socket);
            if (!attachment?.follow || !(await ended(attachment.computerId, attachment.follow))) {
                continue;
            }
            saveAttachment(socket, { follow: null });
            socket.send(
                JSON.stringify({
                    kind: CHANGES_ERROR_KIND,
                    code: "access_ended",
                    status: 401,
                    message: "This access has ended",
                }),
            );
        }
    };

    readonly #openSockets = (): readonly WebSocket[] =>
        this.#state.getWebSockets(BROWSER_TAG).filter((socket) => socket.readyState === WebSocket.OPEN);

    readonly #heardAt = (socket: WebSocket): number | null =>
        this.#state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? readAttachment(socket)?.acceptedAt ?? null;

    readonly #transport = (socket: WebSocket): BrowserTransport | undefined => {
        const known = this.#open.get(socket);
        if (known !== undefined) {
            return known;
        }
        const attachment = readAttachment(socket);
        if (attachment === null) {
            socket.close(1011, "WebSocket transport state unavailable");
            return undefined;
        }
        this.#wake(attachment.computerId);
        this.restore();
        return this.#open.get(socket);
    };

    readonly #openTransport = (socket: WebSocket, attachment: BrowserAttachment): BrowserTransport =>
        openBrowserTransport(
            {
                socket,
                computerId: attachment.computerId,
                subscriptions: attachment.subscriptions,
                saveSubscriptions: (subscriptions) => saveAttachment(socket, { subscriptions }),
                saveFollow: async (follow) => {
                    saveAttachment(socket, { follow });
                    await this.#followsChanged();
                },
            },
            this.#ports,
        );
}

function readAttachment(socket: WebSocket): BrowserAttachment | null {
    const parsed = v.safeParse(attachmentSchema, socket.deserializeAttachment());
    return parsed.success ? parsed.output : null;
}

/** The attachment is the connection's one record, so each change rewrites it from what is saved. */
function saveAttachment(
    socket: WebSocket,
    change: Pick<BrowserAttachment, "follow"> | Pick<BrowserAttachment, "subscriptions">,
): void {
    const saved = readAttachment(socket);
    if (saved !== null) {
        const next: BrowserAttachment = { ...saved, ...change };
        socket.serializeAttachment(next);
    }
}
