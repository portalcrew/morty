import type { NativeSessionCommandRouting, NativeSessionTarget } from "@morty-build/client/protocol";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { logger } from "../../../../infra/logger.ts";
import type { ComputerReplyConnection } from "./computer-control-request.ts";
import type { ComputerOperationSocket, HistoryRequestKind, RelayPeers, RelaySocket } from "./computer-relay-actor.ts";

class LocalComputerRequest extends EventTarget implements ComputerReplyConnection {
    #state: number = WebSocket.OPEN;
    readonly #dispatch: (socket: ComputerOperationSocket, message: unknown) => Promise<void>;
    readonly #release: () => void;
    readonly server: ComputerOperationSocket;

    constructor(dispatch: (socket: ComputerOperationSocket, message: unknown) => Promise<void>, release: () => void) {
        super();
        this.#dispatch = dispatch;
        this.#release = release;
        let history: { readonly kind: HistoryRequestKind; readonly requestId: string } | null = null;
        let request:
            | { readonly kind: "not-forwarded" }
            | {
                  readonly kind: "forwarded";
                  readonly daemon: RelaySocket;
                  readonly action: NativeSessionCommandRouting["action"];
              } = { kind: "not-forwarded" };
        const discoveries = new Map<string, string>();
        this.server = {
            recordRequestDaemon: (daemon, action) => {
                request = { kind: "forwarded", daemon, action };
            },
            requestDaemon: () => (request.kind === "forwarded" ? request.daemon : null),
            requestAction: () => (request.kind === "forwarded" ? request.action : null),
            close: (code, reason) => this.close(code, reason),
            send: (message) => {
                if (this.isOpen()) {
                    this.dispatchEvent(new MessageEvent("message", { data: message }));
                }
            },
            isOpen: () => this.isOpen(),
            isSame: (socket) => socket === this.server,
            bindHistoryRequest: (kind, requestId) => {
                history = { kind, requestId };
            },
            matchesHistoryRequest: (kind, requestId) => history?.kind === kind && history.requestId === requestId,
            trackAgentSettingsDiscovery: (requestId, harness) => {
                const existing = discoveries.get(requestId);
                if (existing !== undefined) {
                    return existing === harness ? "duplicate" : "busy";
                }
                if (discoveries.size >= 4) {
                    return "busy";
                }
                discoveries.set(requestId, harness);
                return "tracked";
            },
            consumeAgentSettingsDiscovery: (requestId, harness) => {
                if (discoveries.get(requestId) !== harness) {
                    return false;
                }
                return discoveries.delete(requestId);
            },
            consumeAgentSettingsDiscoveryFailure: (requestId) => discoveries.delete(requestId),
            takeAgentSettingsDiscoveries: () => {
                const ids = [...discoveries.keys()];
                discoveries.clear();
                return ids;
            },
        };
    }
    get readyState(): number {
        return this.#state;
    }
    private readonly isOpen = () => this.#state === WebSocket.OPEN;
    readonly accept = (): void => {};
    readonly send = (message: string | ArrayBuffer | ArrayBufferView): void => {
        if (!this.isOpen()) {
            throw new Error("The Computer request is closed");
        }
        void this.#dispatch(this.server, message).catch((cause: unknown) => {
            logger.error({ err: cause, event: "computer_local_request_failed" }, "Computer local request failed");
            this.dispatchEvent(new Event("error"));
            this.close();
        });
    };
    readonly close = (_code?: number, _reason?: string): void => {
        if (!this.isOpen()) {
            return;
        }
        this.#state = WebSocket.CLOSED;
        this.#release();
        this.dispatchEvent(new Event("close"));
    };
}

export class LocalComputerRequests {
    readonly #routes = new Set<ReturnType<RelayPeers["operations"]>[number]>();
    readonly routes = () => [...this.#routes];
    readonly open = (
        requestId: string,
        target: NativeSessionTarget | undefined,
        dispatch: (socket: ComputerOperationSocket, message: unknown) => Promise<void>,
    ) => {
        for (const route of this.#routes) {
            if (route.requestId === requestId) {
                throw new SessionRuntimeError(
                    "session_busy",
                    "An operation with this request ID is already in progress",
                );
            }
        }
        const connection = new LocalComputerRequest(dispatch, () => this.#routes.delete(route));
        const route = { socket: connection.server, requestId, target };
        this.#routes.add(route);
        return connection;
    };
}
