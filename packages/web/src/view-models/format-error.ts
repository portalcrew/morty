import { MortyError, MortyOperationError } from "@morty-build/client";
import { SESSION_CLOSED_ERROR_CODE } from "@morty-build/client/protocol";
import { isApiConnectionError } from "../services/api/worker-api-transport.ts";
import { isComputerConnectionFailure } from "../services/management/management-api.ts";

/** The copy of a page that failed because the Computer is unreachable. */
export const computerDisconnectedFailure = {
    detail: "Start your Morty Computer to reconnect, then try again.",
    title: "Your Morty Computer is disconnected.",
} as const;

/** How a failure because the Computer cannot be reached reads everywhere. */
export const computerDisconnectedMessage = `${computerDisconnectedFailure.title} ${computerDisconnectedFailure.detail}`;

/**
 * What a page that failed to load tells the user: the Computer being unreachable reads one way everywhere, and any
 * other failure keeps its own message.
 */
export type PageFailure =
    | { readonly kind: "computer-disconnected" }
    | { readonly kind: "message"; readonly message: string };

const failureTitleLimit = 80;

function splitFailureMessage(
    message: string,
): Readonly<{ readonly title: string; readonly content: string }> | undefined {
    const match = /^(.+?[.!?])\s+(\S[\s\S]*)$/u.exec(message.trim());
    const sentence = match?.[1];
    const content = match?.[2]?.trim();
    if (
        sentence === undefined ||
        content === undefined ||
        content.length === 0 ||
        sentence.length > failureTitleLimit
    ) {
        return undefined;
    }
    return { title: sentence.replace(/[.!?]$/u, ""), content };
}

export function describePageFailure(
    message: string,
    title: string,
): Readonly<{ readonly title: string; readonly content: string }> {
    return splitFailureMessage(message) ?? { title, content: message };
}

// A revoked Session credential is replaced on the next attempt, which asks Chat again and so learns whether the
// access behind it ended.
const retryableComputerFailureCodes = new Set([
    "computer_offline",
    "service_unavailable",
    "credential_revoked",
    "operation_timeout",
]);

/**
 * Map a caught error to the single user-facing message for it. Known error
 * codes are translated to unified copy here so the same failure reads the same
 * everywhere; any other Error keeps its own sanitized message, and a non-Error
 * cause falls back to the caller's context-specific message.
 */
export function formatError(cause: unknown, fallback: string): string {
    if (isComputerConnectionFailure(cause)) {
        return computerDisconnectedMessage;
    }
    return cause instanceof Error ? cause.message : fallback;
}

/**
 * Whether an operation failed because the Computer is archiving the Session, so it takes no more operations.
 */
export function isSessionClosedFailure(cause: unknown): cause is MortyError {
    return cause instanceof MortyError && cause.code === SESSION_CLOSED_ERROR_CODE;
}

/**
 * Whether a Session connection failure comes from the Computer being unreachable.
 * Such failures heal once the Computer returns (for example after a daemon
 * upgrade), so the Session keeps retrying them instead of settling as failed.
 */
export function isRetryableComputerConnectionFailure(cause: unknown): boolean {
    if (cause instanceof MortyOperationError) {
        return cause.outcome === "unknown";
    }
    if (
        isApiConnectionError(cause) ||
        isComputerConnectionFailure(cause) ||
        (cause instanceof DOMException && cause.name === "TimeoutError")
    ) {
        return true;
    }
    return cause instanceof MortyError && retryableComputerFailureCodes.has(cause.code);
}
