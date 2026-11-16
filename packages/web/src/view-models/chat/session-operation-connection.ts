import { type MortyClient, MortyConnectionError } from "@portalcrew/morty-client";
import { connectionReadiness, type SessionConnection } from "./session-connection.ts";

/**
 * The pane that follows the Session, as the Session's operations reach the Computer through it. Its connection is read
 * as it is now, never copied, so the pane's state is the only account of the connection.
 */
interface SessionFollowingPane {
    readonly connection: () => SessionConnection;
    /**
     * An operation sent through `client` failed with `cause`. The pane closes when the failure says the Session is
     * closed and `client` is still the one it follows the Session through: a client that a reopening or reconnection
     * replaced describes the Session as it was.
     */
    readonly failedThrough: (client: MortyClient, cause: unknown) => void;
}

/** One pane's following of the Session: it reports each change of its connection and its own stop. */
export interface SessionConnectionFollower {
    readonly changed: () => void;
    readonly stopped: () => void;
}

/**
 * How the Session's operations reach the Computer, whichever pane follows the Session. An operation waits while no
 * following pane's connection is ready, so switching panes delays an operation instead of ending it. A request already
 * sent keeps the client it started with until the operation settles, even after its pane stops following it.
 */
export interface SessionOperationConnection {
    /** Ends viewing immediately and closes this Session's client once its operations settle. */
    readonly release: (client: MortyClient) => void;
    /** Starts following the Session through `pane`, replacing any pane that followed it before. */
    readonly follow: (pane: SessionFollowingPane) => SessionConnectionFollower;
    /** The ready client, waiting until one is ready; rejects when the connection cannot carry operations. */
    readonly ready: (signal: AbortSignal) => Promise<MortyClient>;
    /**
     * Sends `request` through the ready client, waiting for one until `signal` ends. A failure goes to the pane that
     * followed the Session through that client before it is rethrown.
     */
    readonly send: <Result>(
        request: (client: MortyClient, signal: AbortSignal) => Promise<Result>,
        signal: AbortSignal,
    ) => Promise<Result>;
}

export function createSessionOperationConnection(): SessionOperationConnection {
    type ClientUse =
        | { readonly kind: "in-use"; readonly operations: number }
        | { readonly kind: "retiring"; readonly operations: number };
    const clients = new Map<MortyClient, ClientUse>();
    let following: SessionFollowingPane | null = null;
    const waiters = new Set<() => void>();
    const readyClient = async (
        signal: AbortSignal,
    ): Promise<{ readonly client: MortyClient; readonly pane: SessionFollowingPane }> => {
        for (;;) {
            signal.throwIfAborted();
            const pane = following;
            const readiness = pane === null ? { kind: "waiting" as const } : connectionReadiness(pane.connection());
            if (pane !== null && readiness.kind === "ready") {
                return { client: readiness.client, pane };
            }
            if (readiness.kind === "unavailable") {
                throw readiness.failure;
            }
            await new Promise<void>((resolve, reject) => {
                const wake = (): void => {
                    cleanup();
                    resolve();
                };
                const abort = (): void => {
                    cleanup();
                    reject(signal.reason);
                };
                const cleanup = (): void => {
                    waiters.delete(wake);
                    signal.removeEventListener("abort", abort);
                };
                waiters.add(wake);
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    };
    const wakeAll = (): void => {
        for (const wake of [...waiters]) {
            wake();
        }
    };
    return {
        release: (client) => {
            client.events.close();
            const use = clients.get(client);
            if (use === undefined) {
                client.close();
            } else {
                clients.set(client, { kind: "retiring", operations: use.operations });
            }
        },
        follow: (pane) => {
            following = pane;
            wakeAll();
            return {
                changed: () => {
                    if (following === pane) {
                        wakeAll();
                    }
                },
                stopped: () => {
                    if (following === pane) {
                        following = null;
                    }
                },
            };
        },
        ready: async (signal) => (await readyClient(signal)).client,
        send: async (request, signal) => {
            const { client, pane } = await readyClient(signal);
            const use = clients.get(client);
            if (use?.kind === "retiring") {
                throw new MortyConnectionError("The Session connection is being released");
            }
            clients.set(client, { kind: "in-use", operations: (use?.operations ?? 0) + 1 });
            try {
                return await request(client, signal);
            } catch (cause) {
                if (!signal.aborted) {
                    pane.failedThrough(client, cause);
                }
                throw cause;
            } finally {
                const current = clients.get(client);
                if (current !== undefined) {
                    if (current.operations === 1) {
                        clients.delete(client);
                        if (current.kind === "retiring") {
                            client.close();
                        }
                    } else {
                        clients.set(client, { ...current, operations: current.operations - 1 });
                    }
                }
            }
        },
    };
}
