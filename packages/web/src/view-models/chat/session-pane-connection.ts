import { type MortyClient, MortyError, type MortySessionEventObserver } from "@portalcrew/morty-client";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { recordBrowserDiagnostic } from "../../services/diagnostics/browser-diagnostics.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableComputerConnectionFailure, isSessionClosedFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";
import { type SessionConnection, sessionUpdatesEndedError } from "./session-connection.ts";
import {
    initialSessionConnection,
    type SessionConnectionEffect,
    type SessionConnectionEvent,
    type SessionConnectionState,
    sameSessionConnection,
    sessionConnectionClient,
    sessionConnectionView,
    transitionSessionConnection,
} from "./session-connection-machine.ts";
import type { SessionConnectionFollower, SessionOperationConnection } from "./session-operation-connection.ts";

export type { SessionConnection } from "./session-connection.ts";

export interface SessionConnectionStore {
    readonly connection: SessionConnection;
    readonly retryNow: () => void;
    /**
     * The owner sees the Computer reachable again: a connection that used up its automatic retries tries once more,
     * without restoring them.
     */
    readonly computerReachable: () => void;
    /**
     * Records that the Computer archived the Session and ends the connection for good. `reason` is the Computer's
     * explanation, or null when a failed operation was the only sign of the closing.
     */
    readonly sessionClosed: (reason: string | null) => void;
    readonly recover: (signal: AbortSignal) => Promise<void>;
}

export const noSessionConnection = createStore<Pick<SessionConnectionStore, "connection">>()(() => ({
    connection: { kind: "first-loading" },
}));

export interface SessionPaneConnection {
    readonly store: StoreApi<SessionConnectionStore>;
    /** The client of the connection now, null while none is open. */
    readonly client: () => MortyClient | null;
    /**
     * Reports a failure of an operation sent through `connected`. A client that a reconnection replaced describes the
     * Session as it was, so only a failure through the current client can close it. True when the Session closed.
     */
    readonly failedThrough: (connected: MortyClient, cause: unknown) => boolean;
    /** Starts the connection loop and lets the Session's operations reach the Computer through it; once per pane. */
    readonly start: (signal: AbortSignal) => void;
    readonly stop: () => void;
}

export function createSessionPaneConnection(options: {
    readonly clock: Clock;
    readonly sessionTarget: NativeSessionTarget;
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly operations: SessionOperationConnection;
    /** The access that opened the Session, which only the first connection reuses. */
    readonly openedAccess: Parameters<BotChatApi["connectSession"]>[2];
    /** What the Session's live events and reconciliation feed into the Session's state. */
    readonly observer: (connected: MortyClient, signal: AbortSignal) => MortySessionEventObserver;
    /** Runs once a connection is subscribed, before it is followed until it ends. */
    readonly subscribed: (signal: AbortSignal) => Promise<void>;
    readonly onConnected: () => void;
    readonly onWaitingForComputer: () => void;
    readonly onClosed: () => void;
}): SessionPaneConnection {
    const { clock, sessionTarget } = options;
    let connectionState: SessionConnectionState = initialSessionConnection;
    let attempt: AbortController | null = null;
    let countdownInterrupt: AbortController | null = null;
    let recoveryNoticeDeadline: AbortController | null = null;
    let connectionChangedAt = clock.now();
    let follower: SessionConnectionFollower | null = null;
    const currentConnection = (): SessionConnectionState => connectionState;
    const store = createStore<SessionConnectionStore>()(() => ({
        connection: { kind: "first-loading" },
        retryNow: () => {
            dispatch({ kind: "retry-now" });
        },
        computerReachable: () => {
            dispatch({ kind: "computer-reachable" });
        },
        sessionClosed: (reason) => {
            dispatch({ kind: "session-closed", reason });
        },
        recover: async (signal) => {
            signal.throwIfAborted();
            dispatch({ kind: "browser-resumed" });
        },
    }));
    const showConnection = (next: SessionConnectionState): void => {
        connectionState = next;
        const previous = store.getState().connection;
        const shown = sessionConnectionView(next);
        if (sameSessionConnection(previous, shown)) {
            return;
        }
        store.setState({ connection: shown });
        if (shown.kind !== "reconnecting" && (shown.kind !== "disconnected" || shown.retry.kind === "exhausted")) {
            recoveryNoticeDeadline?.abort();
            recoveryNoticeDeadline = null;
        }
        if (shown.kind !== previous.kind) {
            const now = clock.now();
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "web",
                operation: "session-connection",
                outcome: shown.kind,
                elapsedMs: Math.max(0, now - connectionChangedAt),
                requestId: "",
            });
            connectionChangedAt = now;
        }
        follower?.changed();
    };
    const dispatch = (event: SessionConnectionEvent): readonly SessionConnectionEffect[] => {
        const result = transitionSessionConnection(connectionState, event);
        if (result.effects.some((effect) => effect.kind === "closed")) {
            options.onClosed();
        }
        showConnection(result.state);
        for (const effect of result.effects) {
            switch (effect.kind) {
                case "abort-attempt":
                    attempt?.abort(new Error("The Session closed."));
                    break;
                case "interrupt-wait":
                    countdownInterrupt?.abort(new Error("The connection wait was interrupted."));
                    break;
                case "closed":
                case "await-retry":
                case "await-computer":
                    break;
                default:
                    effect satisfies never;
            }
        }
        return result.effects;
    };
    const failedThrough = (connected: MortyClient, cause: unknown): boolean => {
        if (isSessionClosedFailure(cause) && connected === sessionConnectionClient(connectionState)) {
            dispatch({ kind: "session-closed", reason: cause.message });
            return true;
        }
        return false;
    };
    const connect = async (signal: AbortSignal): Promise<void> => {
        // Only the first connection reuses the access that opened the Session. Every reconnection asks Chat
        // again, so access that ended meanwhile, including a revoked Session credential, ends the page's access.
        let openedAccess = options.openedAccess;
        // One grace period per interruption, shared by backoff and reconciliation.
        // Successful recovery or a terminal outcome cancels it when the connection shows it.
        const recoveryNotice = (): "quiet" | "visible" => {
            const current = store.getState().connection;
            if (recoveryNoticeDeadline !== null && !recoveryNoticeDeadline.signal.aborted) {
                return current.kind === "disconnected" || current.kind === "reconnecting" ? current.notice : "quiet";
            }
            recoveryNoticeDeadline = startRecoveryNotice({
                clock,
                signal,
                onNotice: (notice) => {
                    dispatch({ kind: "notice-changed", notice });
                },
            });
            return "quiet";
        };
        const observeSession = async (attemptSignal: AbortSignal): Promise<void> => {
            const access = openedAccess;
            openedAccess = undefined;
            const connected = await options.requests.connectSession(sessionTarget, attemptSignal, access);
            dispatch({ kind: "client-opened", client: connected });
            const subscription = await connected.events.subscribeLive(
                sessionTarget,
                options.observer(connected, attemptSignal),
                attemptSignal,
            );
            attemptSignal.throwIfAborted();
            dispatch({ kind: "subscribed" });
            options.onConnected();
            const monitoring = new AbortController();
            const monitorSignal = AbortSignal.any([attemptSignal, monitoring.signal]);
            void (async () => {
                try {
                    await clock.sleep(25_000, monitorSignal);
                    monitorSignal.throwIfAborted();
                    // Reset backoff only after the subscription stays open; transport
                    // heartbeats detect lost connections without polling Session execution.
                    dispatch({ kind: "stable", client: connected });
                } catch {}
            })();
            try {
                await options.subscribed(attemptSignal);
                attemptSignal.throwIfAborted();
                await subscription.completed;
            } finally {
                monitoring.abort();
            }
            attemptSignal.throwIfAborted();
            throw sessionUpdatesEndedError();
        };
        const wait = async (effects: readonly SessionConnectionEffect[]): Promise<void> => {
            countdownInterrupt = new AbortController();
            const retrySignal = AbortSignal.any([signal, countdownInterrupt.signal]);
            try {
                for (const effect of effects) {
                    if (effect.kind === "await-retry") {
                        const retryAt = clock.now() + effect.delayMs;
                        while (clock.now() < retryAt) {
                            await clock.sleep(Math.min(1000, retryAt - clock.now()), retrySignal);
                            retrySignal.throwIfAborted();
                            dispatch({
                                kind: "retry-ticked",
                                remainingMs: retryAt - clock.now(),
                                notice: recoveryNotice(),
                            });
                        }
                    } else if (effect.kind === "await-computer") {
                        if (effect.notify) {
                            options.onWaitingForComputer();
                        }
                        await new Promise<void>((resolve) => {
                            if (retrySignal.aborted) {
                                resolve();
                                return;
                            }
                            retrySignal.addEventListener("abort", () => resolve(), { once: true });
                        });
                    }
                }
            } catch (cause) {
                if (!retrySignal.aborted) {
                    throw cause;
                }
            }
            countdownInterrupt = null;
        };
        for (;;) {
            if (currentConnection().kind === "closed") {
                return;
            }
            if (currentConnection().kind === "waiting") {
                dispatch({ kind: "attempt-starting", notice: recoveryNotice() });
            }
            const running = new AbortController();
            attempt = running;
            try {
                await observeSession(AbortSignal.any([signal, running.signal]));
            } catch (failure) {
                const cause = running.signal.aborted ? running.signal.reason : failure;
                running.abort();
                attempt = null;
                const opened = sessionConnectionClient(currentConnection());
                if (opened !== null) {
                    options.operations.release(opened);
                }
                if (signal.aborted) {
                    return;
                }
                const message = formatError(cause, "The Session could not be opened.");
                const effects = dispatch({
                    kind: "attempt-failed",
                    failure: isSessionClosedFailure(cause)
                        ? { kind: "session-closed", reason: cause.message }
                        : isRetryableComputerConnectionFailure(cause)
                          ? { kind: "retryable", message, notice: recoveryNotice() }
                          : { kind: "terminal", message },
                    jitter: Math.random(),
                });
                const interrupted = currentConnection();
                if (interrupted.kind === "closed") {
                    continue;
                }
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "web",
                    operation: "session-interruption",
                    outcome: cause instanceof MortyError ? cause.code : "api_unavailable",
                    attempt: interrupted.kind === "waiting" ? interrupted.failures : 0,
                    elapsedMs: 0,
                    requestId: "",
                });
                await wait(effects);
                if (signal.aborted) {
                    return;
                }
            }
        }
    };
    return {
        store,
        client: () => sessionConnectionClient(connectionState),
        failedThrough,
        start: (signal) => {
            follower = options.operations.follow({
                connection: () => store.getState().connection,
                failedThrough: (client, cause) => {
                    failedThrough(client, cause);
                },
            });
            void connect(signal).catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "session-pane-connect");
                }
            });
        },
        stop: () => {
            follower?.stopped();
            follower = null;
        },
    };
}
