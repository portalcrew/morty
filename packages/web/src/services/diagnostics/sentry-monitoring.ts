import { breadcrumbsIntegration, browserTracingIntegration, type Event, getClient, init } from "@sentry/react";
import { browserDiagnosticsSnapshot } from "./browser-diagnostics.ts";

import { sessionOpenTimingPath } from "./session-open-timing.ts";

function isSessionTimingRequest(url: unknown): boolean {
    return (
        typeof url === "string" &&
        (url === sessionOpenTimingPath || url === window.location.origin + sessionOpenTimingPath)
    );
}

const lastErrors = new WeakMap<NonNullable<ReturnType<typeof getClient>>, string>();

export function lastErrorEventId(): string | null {
    const client = getClient();
    return client === undefined ? null : (lastErrors.get(client) ?? null);
}

function withoutQuery(value: string): string {
    try {
        const url = new URL(value, window.location.origin);
        return `${url.origin}${url.pathname}`;
    } catch {
        return "[invalid URL]";
    }
}

function sanitizeEvent<T extends Event>(event: T): T {
    delete event.user;
    delete event.extra;
    if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
        delete event.request.query_string;
        if (event.request.url) {
            event.request.url = withoutQuery(event.request.url);
        }
    }
    // Exception messages can contain a server response, prompt, local path or token.
    // Keep symbolication evidence and stable error codes instead of arbitrary text.
    if (event.message !== undefined) {
        event.message = "Application diagnostic";
    }
    for (const exception of event.exception?.values ?? []) {
        exception.value = "Error details omitted for privacy";
        if (exception.mechanism) {
            delete exception.mechanism.data;
        }
        for (const frame of exception.stacktrace?.frames ?? []) {
            delete frame.vars;
            if (frame.filename) {
                frame.filename = withoutQuery(frame.filename);
            }
            if (frame.abs_path) {
                frame.abs_path = withoutQuery(frame.abs_path);
            }
        }
    }
    return event;
}

export function initializeBrowserMonitoring(configuration: {
    readonly dsn: string;
    readonly environment: string;
    readonly release: string;
}) {
    const client = init({
        dsn: configuration.dsn,
        initialScope: { tags: { component: "web" } },
        environment: configuration.environment,
        release: configuration.release,
        // Collect nothing about the user, their requests or their queries beyond what the hooks below keep.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            mcp: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
        },
        // Console output and DOM interactions are not recorded as breadcrumbs.
        integrations: (defaults) => [
            ...defaults.filter((integration) => integration.name !== "Console" && integration.name !== "Breadcrumbs"),
            breadcrumbsIntegration({ dom: false }),
            browserTracingIntegration({
                shouldCreateSpanForRequest: (url) => !isSessionTimingRequest(url),
                beforeStartSpan: (options) => ({ ...options, name: window.location.pathname }),
            }),
        ],
        tracesSampleRate: configuration.environment === "production" ? 0.1 : 1,
        tracePropagationTargets: [],
        beforeBreadcrumb: (breadcrumb) => {
            if (isSessionTimingRequest(breadcrumb.data?.["url"])) {
                return null;
            }
            if (!["fetch", "xhr", "navigation"].includes(breadcrumb.category ?? "")) {
                return null;
            }
            if (breadcrumb.data) {
                for (const key of ["url", "from", "to"]) {
                    const value: unknown = breadcrumb.data[key];
                    if (typeof value === "string") {
                        breadcrumb.data[key] = withoutQuery(value);
                    }
                }
            }
            return breadcrumb;
        },
        beforeSend: (event, hint) => {
            event.contexts = { ...event.contexts, morty: { diagnostics: browserDiagnosticsSnapshot() } };
            const error = hint.originalException;
            if (error instanceof Error) {
                const code: unknown = Reflect.get(error, "code");
                const requestId: unknown = Reflect.get(error, "requestId");
                if (typeof code === "string" && /^[A-Za-z][A-Za-z_0-9]{0,63}$/u.test(code)) {
                    event.tags = { ...event.tags, errorCode: code };
                }
                if (typeof requestId === "string" && /^[a-f0-9-]{36}$/u.test(requestId)) {
                    event.tags = { ...event.tags, requestId };
                }
            }
            return sanitizeEvent(event);
        },
        beforeSendTransaction: sanitizeEvent,
        beforeSendSpan: (span) => {
            for (const key of ["url.full", "http.url"]) {
                const value = span.attributes[key];
                if (typeof value === "string") {
                    span.attributes[key] = withoutQuery(value);
                }
            }
            const operation = span.attributes["sentry.op"];
            if (/^https?:\/\//u.test(span.name)) {
                span.name = withoutQuery(span.name);
            } else if (typeof operation === "string" && operation.startsWith("http")) {
                const parts = span.name.split(" ", 2);
                span.name =
                    parts.length === 2 ? `${parts[0]} ${withoutQuery(parts[1] ?? "")}` : withoutQuery(span.name);
            }
            return span;
        },
    });
    client?.on("beforeSendEvent", (event) => {
        if (event.type === undefined && event.exception && event.event_id) {
            lastErrors.set(client, event.event_id);
        }
    });
    return client;
}
