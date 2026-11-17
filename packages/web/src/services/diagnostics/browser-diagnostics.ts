import type { ComputerDiagnosticsResult } from "@portalcrew/morty-client/protocol";
import type { ChatDiagnostics } from "./model-catalog.ts";
import type { ServerNetworkOperations } from "./network-diagnostics.ts";

export interface BrowserDiagnostic {
    readonly at: string;
    readonly component: "worker" | "relay" | "web";
    readonly operation: string;
    readonly outcome: string;
    readonly requestId: string;
    readonly elapsedMs: number;
    readonly attempt?: number;
}
const entries: BrowserDiagnostic[] = [];
let discarded = 0;
export function recordBrowserDiagnostic(entry: BrowserDiagnostic): void {
    entries.push({
        ...entry,
        operation: entry.operation.slice(0, 80),
        outcome: entry.outcome.slice(0, 64),
        requestId: entry.requestId.slice(0, 64),
    });
    if (entries.length > 100) {
        entries.shift();
        discarded += 1;
    }
}
interface BrowserDiagnosticsSnapshot {
    readonly entries: readonly BrowserDiagnostic[];
    readonly discarded: number;
}
export const browserDiagnosticsSnapshot = (): BrowserDiagnosticsSnapshot => ({ entries: [...entries], discarded });

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
