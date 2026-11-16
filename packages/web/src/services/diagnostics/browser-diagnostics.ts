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
// Never store arbitrary error messages: they may contain prompts, paths or credentials.
export function recordBrowserError(operation: string, cause?: unknown): void {
    const code: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
    const requestId: unknown = cause instanceof Error ? Reflect.get(cause, "requestId") : undefined;
    recordBrowserDiagnostic({
        at: new Date().toISOString(),
        component: "web",
        operation,
        outcome: typeof code === "string" && /^[A-Z][A-Z_]{1,63}$/u.test(code) ? code : "error",
        requestId: typeof requestId === "string" && /^[a-f0-9-]{36}$/u.test(requestId) ? requestId : "",
        elapsedMs: 0,
    });
}
