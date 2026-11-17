import type { MortyLiveEventsObservation, MortyRequestObservation } from "@portalcrew/morty-client";
import type { ComputerDiagnosticsResult } from "@portalcrew/morty-client/protocol";
import {
    BROWSER_DIAGNOSTICS_MAX_ENTRIES,
    type BrowserDiagnostic,
    browserDiagnosticsEntry,
    centralSessionStorage,
} from "../session-storage/central-session-storage.ts";
import type { ChatDiagnostics } from "./model-catalog.ts";
import type { ServerNetworkOperations } from "./network-diagnostics.ts";

const RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
// Records that could not be stored; counted so a report never passes a gap off as a quiet history.
let unstored = 0;

/**
 * Records are kept, oldest first, in this tab's session storage. Records older than a day or beyond the newest
 * hundred are dropped and counted as discarded.
 */
export function recordBrowserDiagnostic(entry: BrowserDiagnostic): void {
    const stored = centralSessionStorage.read(browserDiagnosticsEntry) ?? { entries: [], discarded: 0 };
    const recordedAt = Date.parse(entry.at);
    const retained = stored.entries.filter(({ at }) => recordedAt - Date.parse(at) <= RETENTION_MILLISECONDS);
    const entries = [
        ...retained,
        {
            ...entry,
            operation: entry.operation.slice(0, 80),
            outcome: entry.outcome.slice(0, 64),
            requestId: entry.requestId.slice(0, 64),
        },
    ];
    const overflow = Math.max(0, entries.length - BROWSER_DIAGNOSTICS_MAX_ENTRIES);
    const written = centralSessionStorage.write(browserDiagnosticsEntry, {
        entries: entries.slice(overflow),
        discarded: stored.discarded + (stored.entries.length - retained.length) + overflow,
    });
    if (!written) {
        unstored += 1;
    }
}
interface BrowserDiagnosticsSnapshot {
    readonly entries: readonly BrowserDiagnostic[];
    readonly discarded: number;
}
export const browserDiagnosticsSnapshot = (): BrowserDiagnosticsSnapshot => {
    const stored = centralSessionStorage.read(browserDiagnosticsEntry) ?? { entries: [], discarded: 0 };
    return { entries: stored.entries, discarded: stored.discarded + unstored };
};

export interface DaemonDiagnosticsSource extends ServerNetworkOperations {
    readonly computerId: string;
    readonly harness: string | null;
    readonly sessionId: string | null;
    readonly context?: () => ChatDiagnostics;
    readonly read: (signal: AbortSignal) => Promise<ComputerDiagnosticsResult>;
}
// Morty error codes are snake_case in either letter case; error names are class identifiers.
const FAILURE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * How a failure is recorded: by its code, else by its error name. Never by its message, which may quote prompts,
 * paths or credentials.
 */
export function failureOutcome(cause: unknown): string {
    if (!(cause instanceof Error)) {
        return "error";
    }
    const code: unknown = Reflect.get(cause, "code");
    if (typeof code === "string" && FAILURE_IDENTIFIER_PATTERN.test(code)) {
        return code;
    }
    return FAILURE_IDENTIFIER_PATTERN.test(cause.name) ? cause.name : "error";
}

export function recordRequestObservation(
    component: BrowserDiagnostic["component"],
    observation: MortyRequestObservation,
): void {
    recordBrowserDiagnostic({
        at: new Date().toISOString(),
        component,
        operation: observation.operation,
        outcome:
            observation.outcome.kind === "answered"
                ? String(observation.outcome.status)
                : failureOutcome(observation.outcome.failure),
        requestId: observation.requestId,
        elapsedMs: observation.elapsedMilliseconds,
    });
}

/** A live Session subscription is recorded under its subscription ID, the identity the Relay logs it by. */
export function recordLiveEventsObservation(observation: MortyLiveEventsObservation): void {
    recordBrowserDiagnostic({
        at: new Date().toISOString(),
        component: "relay",
        operation: "session-live-events",
        outcome: observation.kind === "opened" ? "opened" : failureOutcome(observation.failure),
        requestId: observation.subscriptionId,
        elapsedMs: 0,
    });
}

export function recordBrowserError(operation: string, cause?: unknown): void {
    const requestId: unknown = cause instanceof Error ? Reflect.get(cause, "requestId") : undefined;
    recordBrowserDiagnostic({
        at: new Date().toISOString(),
        component: "web",
        operation,
        outcome: failureOutcome(cause),
        requestId: typeof requestId === "string" && /^[a-f0-9-]{36}$/u.test(requestId) ? requestId : "",
        elapsedMs: 0,
    });
}
