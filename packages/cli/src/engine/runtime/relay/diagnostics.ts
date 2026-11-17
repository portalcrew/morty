import { describeEnvironmentProxyRoute } from "../../util/network/environment-proxy.ts";
import type { RuntimeDiagnosticLog } from "../observability/diagnostic-log.ts";

const MAX_DIAGNOSTIC_TEXT_LENGTH = 256;

function sanitizeDiagnosticText(value: string): string {
    const printable = Array.from(value, (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
    }).join("");
    const withoutSecrets = printable
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [redacted]")
        .replace(/([?&](?:access_token|authorization|credential|key|secret|token)=)[^&\s]*/giu, "$1[redacted]")
        .replace(/(?:https?|wss?):\/\/[^\s)]+/giu, (encodedUrl) => {
            try {
                return new URL(encodedUrl).origin;
            } catch {
                return "[redacted-url]";
            }
        });
    return withoutSecrets.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function addFailureDetails(details: Record<string, string>, failure: unknown): void {
    let current = failure;
    for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
        const prefix = depth === 0 ? "failure" : `cause${depth.toString()}`;
        details[`${prefix}Name`] = sanitizeDiagnosticText(current.name);
        details[`${prefix}Message`] = sanitizeDiagnosticText(current.message);
        const code = Reflect.get(current, "code");
        if (typeof code === "string" || typeof code === "number") {
            details[`${prefix}Code`] = sanitizeDiagnosticText(String(code));
        }
        const statusCode = Reflect.get(current, "statusCode");
        if (typeof statusCode === "string" || typeof statusCode === "number") {
            details[`${prefix}StatusCode`] = sanitizeDiagnosticText(String(statusCode));
        }
        for (const field of ["syscall", "errno", "address", "port"]) {
            const value: unknown = Reflect.get(current, field);
            if (typeof value === "string" || typeof value === "number") {
                const key = depth === 0 ? field : `${prefix}${field.slice(0, 1).toUpperCase()}${field.slice(1)}`;
                details[key] = sanitizeDiagnosticText(String(value));
            }
        }
        const diagnosticDetails = Reflect.get(current, "diagnosticDetails");
        if (typeof diagnosticDetails === "object" && diagnosticDetails !== null) {
            for (const [key, value] of Object.entries(diagnosticDetails)) {
                if (typeof value === "string") {
                    details[key] = sanitizeDiagnosticText(value);
                }
            }
        }
        current = current.cause;
    }
}

type RecordConnectionEvent = (event: string, details: Readonly<Record<string, string>>, warning: boolean) => void;

type RelayConnectionIdentity =
    | { readonly kind: "unconfirmed" }
    | { readonly kind: "confirmed"; readonly relayConnectionEpoch: number };

/**
 * The records of one connection attempt. The attempt number is this daemon's own count and includes attempts the Relay
 * never accepted; once the Relay confirms the connection, its records also carry the Relay's connection epoch, the
 * identity the Relay logs for the same connection.
 */
export class RelayConnectionRecords {
    readonly #attempt: number;
    readonly #record: RecordConnectionEvent;
    #identity: RelayConnectionIdentity = { kind: "unconfirmed" };
    #closeRecorded = false;
    #failureRecorded = false;

    constructor(attempt: number, record: RecordConnectionEvent) {
        this.#attempt = attempt;
        this.#record = record;
    }

    readonly opened = (): void => {
        this.#record("relay_connection_opened", this.#fields(), false);
    };

    readonly confirmed = (relayConnectionEpoch: number): void => {
        this.#identity = { kind: "confirmed", relayConnectionEpoch };
        this.#record("relay_connection_confirmed", this.#fields(), false);
    };

    /** This daemon is about to close the connection; recorded before any cleanup. */
    readonly closing = (code: number, reason: string, source: string): void => {
        this.#recordClose({
            closeCode: code.toString(),
            closeReason: sanitizeDiagnosticText(reason),
            initiator: "runtime",
            source,
        });
    };

    /**
     * The connection closed or failed without this daemon closing it. A received close frame or a reset only shows what
     * arrived here, not which peer or intermediary decided it.
     */
    readonly closeObserved = (code: number, reason: string, wasClean: boolean, source: string): void => {
        this.#recordClose({
            closeCode: code.toString(),
            closeReason: sanitizeDiagnosticText(reason),
            initiator: "unattributed",
            source,
            wasClean: String(wasClean),
        });
    };

    readonly failed = (failure: unknown, source: string): void => {
        if (this.#failureRecorded) {
            return;
        }
        this.#failureRecorded = true;
        const details: Record<string, string> = { ...this.#fields(), source };
        addFailureDetails(details, failure);
        this.#record("relay_connection_failed", details, true);
    };

    readonly transportFailed = (failure: Error, source: string): void => {
        const details: Record<string, string> = { ...this.#fields(), source };
        addFailureDetails(details, failure);
        this.#record("relay_transport_failed", details, true);
    };

    readonly heartbeatTimedOut = (timeoutMilliseconds: number): void => {
        this.#record(
            "relay_heartbeat_timed_out",
            { ...this.#fields(), timeoutMilliseconds: timeoutMilliseconds.toString() },
            true,
        );
    };

    readonly #recordClose = (details: Readonly<Record<string, string>>): void => {
        if (this.#closeRecorded) {
            return;
        }
        this.#closeRecorded = true;
        this.#record("relay_connection_closed", { ...this.#fields(), ...details }, true);
    };

    readonly #fields = (): Readonly<Record<string, string>> =>
        this.#identity.kind === "confirmed"
            ? {
                  connectionAttempt: this.#attempt.toString(),
                  relayConnectionEpoch: this.#identity.relayConnectionEpoch.toString(),
              }
            : { connectionAttempt: this.#attempt.toString() };
}

export class RelayConnectionDiagnostics {
    #lastSkippedLogAt = Number.NEGATIVE_INFINITY;
    #skippedCount = 0;
    readonly #computerId: string;
    readonly #localLog: RuntimeDiagnosticLog;
    readonly #relayOrigin: string;
    readonly #route: Readonly<Record<string, string>>;

    constructor(computerId: string, relayUrl: URL, localLog: RuntimeDiagnosticLog) {
        this.#computerId = computerId;
        this.#localLog = localLog;
        this.#relayOrigin = relayUrl.origin;
        this.#route = describeEnvironmentProxyRoute(relayUrl);
    }

    readonly snapshot = (current: readonly Readonly<Record<string, string>>[] = []) => this.#localLog.snapshot(current);

    readonly catalogFailed = (failure: unknown): void => {
        const details: Record<string, string> = { ...this.#route, relayOrigin: this.#relayOrigin };
        addFailureDetails(details, failure);
        this.#record("agent_catalog_publish_failed", details, true);
    };

    readonly connection = (attempt: number): RelayConnectionRecords =>
        new RelayConnectionRecords(attempt, (event, details, warning) =>
            this.#record(event, { ...details, relayOrigin: this.#relayOrigin, ...this.#route }, warning),
        );

    readonly daemonDiagnostic = (
        event: string,
        requestId: string,
        details: Readonly<Record<string, string>>,
        failure?: unknown,
    ): void => {
        if (
            event === "protocol_message_discarded" ||
            event === "content_frame_discarded" ||
            event === "content_chunk_discarded" ||
            event === "prompt_attachments_skipped"
        ) {
            this.#skippedCount += 1;
            const now = Date.now();
            if (now - this.#lastSkippedLogAt < 60_000) {
                return;
            }
            details = { ...details, skippedCount: this.#skippedCount.toString() };
            this.#lastSkippedLogAt = now;
            this.#skippedCount = 0;
        }
        const recordedDetails: Record<string, string> = { ...details };
        if (failure !== undefined) {
            addFailureDetails(recordedDetails, failure);
        }
        this.#localLog.record(
            `Morty daemon diagnostic ${JSON.stringify({
                timestamp: new Date().toISOString(),
                computerId: this.#computerId,
                event,
                requestId,
                ...recordedDetails,
            })}`,
        );
    };

    readonly #record = (event: string, details: Readonly<Record<string, string>>, warning: boolean): void => {
        const encoded = JSON.stringify({
            timestamp: new Date().toISOString(),
            computerId: this.#computerId,
            event,
            ...details,
        });
        this.#localLog.record(`Morty relay diagnostic ${encoded}`);
        if (warning) {
            process.stderr.write(`Morty relay diagnostic ${encoded}\n`);
            return;
        }
        process.stdout.write(`Morty relay diagnostic ${encoded}\n`);
    };
}
