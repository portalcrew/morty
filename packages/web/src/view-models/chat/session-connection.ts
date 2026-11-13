import { type MortyClient, MortyError } from "@morty-build/client";
import { SESSION_CLOSED_ERROR_CODE } from "@morty-build/client/protocol";

// The Session pane owns live-stream recovery: the session client never retries, so
// connection attempts and reconciliation share one bounded retry policy.

export type SessionConnection =
    | { readonly kind: "first-loading" }
    | { readonly kind: "ready"; readonly client: MortyClient }
    | { readonly kind: "reconnecting"; readonly message: string | null; readonly notice: "quiet" | "visible" }
    | {
          readonly kind: "disconnected";
          readonly message: string;
          readonly retry: SessionReconnectRetry;
          readonly notice: "quiet" | "visible";
      }
    | {
          /** The Computer archived the Session, so nothing this page does connects to it again. */
          readonly kind: "closed";
          /** The Computer's explanation, or null when this page learned of the closing from a failed operation. */
          readonly reason: string | null;
      }
    | { readonly kind: "failed"; readonly message: string };

type SessionReconnectRetry =
    | { readonly kind: "scheduled"; readonly remainingSeconds: number }
    | { readonly kind: "exhausted" };

const SESSION_RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const SESSION_RECONNECT_DELAY_CAP_MS = 30_000;
const SESSION_AUTO_RECONNECT_ATTEMPTS = 7;

/** The live subscription ended without failing, which only happens when it was closed deliberately. */
const SESSION_UPDATES_ENDED_ERROR_CODE = "session_updates_ended";

export function sessionUpdatesEndedError(): MortyError {
    return new MortyError(
        SESSION_UPDATES_ENDED_ERROR_CODE,
        "Session updates disconnected. Open the Session again to continue.",
    );
}

/**
 * What an operation waiting for the connection can do now: send through the ready client, wait for the connection to
 * settle, or give up with the reason the connection cannot carry it.
 */
export type ConnectionReadiness =
    | { readonly kind: "ready"; readonly client: MortyClient }
    | { readonly kind: "waiting" }
    | { readonly kind: "unavailable"; readonly failure: MortyError };

export function connectionReadiness(connection: SessionConnection): ConnectionReadiness {
    switch (connection.kind) {
        case "ready":
            return { kind: "ready", client: connection.client };
        case "failed":
            return { kind: "unavailable", failure: new MortyError("session_not_connected", connection.message) };
        case "closed":
            return {
                kind: "unavailable",
                failure: new MortyError(SESSION_CLOSED_ERROR_CODE, "The session is closed."),
            };
        case "disconnected":
            return connection.retry.kind === "exhausted"
                ? { kind: "unavailable", failure: new MortyError("session_not_connected", connection.message) }
                : { kind: "waiting" };
        case "first-loading":
        case "reconnecting":
            return { kind: "waiting" };
    }
}

/**
 * Whether the connection used up its automatic retries for a failure the Computer's return can resolve. Such a
 * connection waits for its owner to retry it once the owner sees the Computer reachable again.
 */
export function connectionWaitsForComputer(connection: SessionConnection): boolean {
    return connection.kind === "disconnected" && connection.retry.kind === "exhausted";
}

/**
 * The next retry after `consecutiveFailures` failed attempts: a scheduled
 * automatic retry with its delay, or none once the attempts are used up. `jitter` in [0, 1) spreads the delay.
 */
export function sessionReconnectAttempt(
    consecutiveFailures: number,
    jitter: number,
): { readonly kind: "scheduled"; readonly delayMs: number } | { readonly kind: "exhausted" } {
    if (consecutiveFailures >= SESSION_AUTO_RECONNECT_ATTEMPTS) {
        return { kind: "exhausted" };
    }
    const ceiling = Math.min(
        SESSION_RECONNECT_DELAYS_MS[consecutiveFailures] ?? SESSION_RECONNECT_DELAY_CAP_MS,
        SESSION_RECONNECT_DELAY_CAP_MS,
    );
    return { kind: "scheduled", delayMs: Math.round(ceiling * (0.5 + jitter * 0.5)) };
}

/** The disconnected state while an automatic retry counts down, or after retries are exhausted. */
export function disconnectedConnection(
    message: string,
    remainingMs: number | null,
    notice: "quiet" | "visible",
): SessionConnection {
    return {
        kind: "disconnected",
        message,
        notice,
        retry:
            remainingMs === null
                ? { kind: "exhausted" }
                : { kind: "scheduled", remainingSeconds: Math.ceil(remainingMs / 1000) },
    };
}
