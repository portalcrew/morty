import type { MortyClient } from "@morty-build/client";
import { disconnectedConnection, type SessionConnection, sessionReconnectAttempt } from "./session-connection.ts";

// The pane's connection to its Session is one state machine. The loop that opens, watches and retries the connection
// performs I/O, timers and aborts; every decision about what happens next is made here, from the state and the event.

type Notice = "quiet" | "visible";

/** What the connection remembers across attempts. */
interface Backoff {
    /** The consecutive failed attempts, which sets the next retry's delay. */
    readonly failures: number;
    /** The user or the browser asked to retry at once: the next failure starts the backoff over. */
    readonly recovery: "none" | "requested";
}

/** What a failed connection waits for. */
type Waiting =
    /** An automatic retry counts down. */
    | { readonly kind: "retry"; readonly remainingMs: number; readonly notice: Notice }
    /** The automatic retries are used up: the owner retries once it sees the Computer reachable, or the user does. */
    | { readonly kind: "computer"; readonly notice: Notice }
    /** The failure is not one waiting resolves: only the user's retry opens the connection again. */
    | { readonly kind: "user" };

export type SessionConnectionState =
    /** An attempt is in flight. `interruption` is set once an earlier attempt failed. */
    | ({
          readonly kind: "opening";
          /** The client the attempt opened, once it has one. */
          readonly client: MortyClient | null;
          readonly interruption: { readonly message: string; readonly notice: Notice } | null;
      } & Backoff)
    | ({ readonly kind: "live"; readonly client: MortyClient } & Backoff)
    | ({ readonly kind: "waiting"; readonly message: string; readonly waiting: Waiting } & Backoff)
    /** The Computer archived the Session, so nothing this page does connects to it again. */
    | { readonly kind: "closed"; readonly reason: string | null };

/** How an attempt ended, as the loop classified it. */
type AttemptFailure =
    | { readonly kind: "session-closed"; readonly reason: string }
    | { readonly kind: "retryable"; readonly message: string; readonly notice: Notice }
    | { readonly kind: "terminal"; readonly message: string };

export type SessionConnectionEvent =
    /** The loop starts an attempt; `notice` is the interruption's notice, used when an earlier attempt failed. */
    | { readonly kind: "attempt-starting"; readonly notice: Notice }
    | { readonly kind: "client-opened"; readonly client: MortyClient }
    | { readonly kind: "subscribed" }
    /** The subscription of `client` stayed open long enough to trust it. */
    | { readonly kind: "stable"; readonly client: MortyClient }
    /** `jitter` in [0, 1) spreads the next retry's delay. */
    | { readonly kind: "attempt-failed"; readonly failure: AttemptFailure; readonly jitter: number }
    | { readonly kind: "retry-ticked"; readonly remainingMs: number; readonly notice: Notice }
    | { readonly kind: "notice-changed"; readonly notice: Notice }
    /** The Computer's notice, or a failed operation, says the Session is closed; only the notice has the reason. */
    | { readonly kind: "session-closed"; readonly reason: string | null }
    | { readonly kind: "browser-resumed" }
    | { readonly kind: "retry-now" }
    | { readonly kind: "computer-reachable" };

/** What the loop does as a result: stop what runs, or wait the way the transition says. */
export type SessionConnectionEffect =
    | { readonly kind: "abort-attempt" }
    | { readonly kind: "interrupt-wait" }
    /** The Session's execution settles: nothing runs or waits in a closed Session. */
    | { readonly kind: "closed" }
    | { readonly kind: "await-retry"; readonly delayMs: number }
    /** `notify`: the failure is one the Computer's return resolves, so the owner is told it is waiting. */
    | { readonly kind: "await-computer"; readonly notify: boolean };

interface SessionConnectionResult {
    readonly state: SessionConnectionState;
    readonly effects: readonly SessionConnectionEffect[];
}

export const initialSessionConnection: SessionConnectionState = {
    kind: "opening",
    client: null,
    interruption: null,
    failures: 0,
    recovery: "none",
};

/** The client the connection holds now: the one an attempt opened, or the one that is live. */
export function sessionConnectionClient(state: SessionConnectionState): MortyClient | null {
    switch (state.kind) {
        case "opening":
            return state.client;
        case "live":
            return state.client;
        case "waiting":
        case "closed":
            return null;
    }
}

function waitingView(message: string, waiting: Waiting): SessionConnection {
    switch (waiting.kind) {
        case "retry":
            return disconnectedConnection(message, waiting.remainingMs, waiting.notice);
        case "computer":
            return disconnectedConnection(message, null, waiting.notice);
        case "user":
            return { kind: "failed", message };
    }
}

/** What the views show of the connection. */
export function sessionConnectionView(state: SessionConnectionState): SessionConnection {
    switch (state.kind) {
        case "opening":
            return state.interruption === null
                ? { kind: "first-loading" }
                : { kind: "reconnecting", message: state.interruption.message, notice: state.interruption.notice };
        case "live":
            return { kind: "ready", client: state.client };
        case "waiting":
            return waitingView(state.message, state.waiting);
        case "closed":
            return { kind: "closed", reason: state.reason };
    }
}

/** Whether two connection states show the same thing, so a view need not be told again. */
export function sameSessionConnection(left: SessionConnection, right: SessionConnection): boolean {
    switch (left.kind) {
        case "first-loading":
            return right.kind === "first-loading";
        case "ready":
            return right.kind === "ready" && right.client === left.client;
        case "reconnecting":
            return right.kind === "reconnecting" && right.message === left.message && right.notice === left.notice;
        case "disconnected":
            return (
                right.kind === "disconnected" &&
                right.message === left.message &&
                right.notice === left.notice &&
                (left.retry.kind === "scheduled"
                    ? right.retry.kind === "scheduled" && right.retry.remainingSeconds === left.retry.remainingSeconds
                    : right.retry.kind === "exhausted")
            );
        case "closed":
            return right.kind === "closed" && right.reason === left.reason;
        case "failed":
            return right.kind === "failed" && right.message === left.message;
    }
}

const unchanged = (state: SessionConnectionState): SessionConnectionResult => ({ state, effects: [] });

function failed(
    state: Exclude<SessionConnectionState, { readonly kind: "closed" }>,
    failure: Exclude<AttemptFailure, { readonly kind: "session-closed" }>,
    jitter: number,
): SessionConnectionResult {
    // A requested recovery starts the backoff over, so its failure is retried soon instead of continuing the climb.
    const failures = state.recovery === "requested" ? 0 : state.failures;
    const next = { failures: failures + 1, recovery: "none" } as const;
    if (failure.kind === "terminal") {
        return {
            state: { kind: "waiting", message: failure.message, waiting: { kind: "user" }, ...next },
            effects: [{ kind: "await-computer", notify: false }],
        };
    }
    const retry = sessionReconnectAttempt(failures, jitter);
    if (retry.kind === "exhausted") {
        return {
            state: {
                kind: "waiting",
                message: failure.message,
                waiting: { kind: "computer", notice: failure.notice },
                ...next,
            },
            effects: [{ kind: "await-computer", notify: true }],
        };
    }
    return {
        state: {
            kind: "waiting",
            message: failure.message,
            waiting: { kind: "retry", remainingMs: retry.delayMs, notice: failure.notice },
            ...next,
        },
        effects: [{ kind: "await-retry", delayMs: retry.delayMs }],
    };
}

export function transitionSessionConnection(
    state: SessionConnectionState,
    event: SessionConnectionEvent,
): SessionConnectionResult {
    switch (event.kind) {
        case "attempt-starting":
            return state.kind === "waiting"
                ? {
                      state: {
                          kind: "opening",
                          client: null,
                          interruption: { message: state.message, notice: event.notice },
                          failures: state.failures,
                          recovery: state.recovery,
                      },
                      effects: [],
                  }
                : unchanged(state);
        case "client-opened":
            return state.kind === "opening"
                ? { state: { ...state, client: event.client }, effects: [] }
                : unchanged(state);
        case "subscribed":
            return state.kind === "opening" && state.client !== null
                ? {
                      state: { kind: "live", client: state.client, failures: state.failures, recovery: state.recovery },
                      effects: [],
                  }
                : unchanged(state);
        case "stable":
            return state.kind === "live" && state.client === event.client
                ? { state: { ...state, failures: 0 }, effects: [] }
                : unchanged(state);
        case "attempt-failed":
            if (state.kind === "closed") {
                return unchanged(state);
            }
            if (event.failure.kind === "session-closed") {
                return { state: { kind: "closed", reason: event.failure.reason }, effects: [{ kind: "closed" }] };
            }
            return failed(state, event.failure, event.jitter);
        case "retry-ticked":
            return state.kind === "waiting" && state.waiting.kind === "retry"
                ? {
                      state: {
                          ...state,
                          waiting: { kind: "retry", remainingMs: event.remainingMs, notice: event.notice },
                      },
                      effects: [],
                  }
                : unchanged(state);
        case "notice-changed":
            if (state.kind === "opening" && state.interruption !== null) {
                return {
                    state: { ...state, interruption: { ...state.interruption, notice: event.notice } },
                    effects: [],
                };
            }
            if (state.kind === "waiting" && state.waiting.kind !== "user") {
                return { state: { ...state, waiting: { ...state.waiting, notice: event.notice } }, effects: [] };
            }
            return unchanged(state);
        case "session-closed":
            if (state.kind === "closed") {
                // A failed operation and the Computer's notice can both report one closing; the notice has the reason.
                return state.reason === null && event.reason !== null
                    ? { state: { kind: "closed", reason: event.reason }, effects: [] }
                    : unchanged(state);
            }
            return {
                state: { kind: "closed", reason: event.reason },
                effects: [{ kind: "abort-attempt" }, { kind: "interrupt-wait" }, { kind: "closed" }],
            };
        case "browser-resumed":
            // A foreground hint can expedite recovery without replenishing every short-lived connection's retry budget.
            if (state.kind === "waiting" && state.waiting.kind !== "user") {
                return {
                    state: { ...state, recovery: state.waiting.kind === "computer" ? "requested" : state.recovery },
                    effects: [{ kind: "interrupt-wait" }],
                };
            }
            return unchanged(state);
        case "retry-now":
            return state.kind === "closed"
                ? unchanged(state)
                : { state: { ...state, recovery: "requested" }, effects: [{ kind: "interrupt-wait" }] };
        case "computer-reachable":
            return state.kind === "waiting" && state.waiting.kind === "computer"
                ? { state, effects: [{ kind: "interrupt-wait" }] }
                : unchanged(state);
        default:
            return event satisfies never;
    }
}
