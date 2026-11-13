import { MortyValidationError, WsTransport } from "@morty-build/client";
import { isIdentifier } from "@morty-build/client/protocol";
import { recordBrowserDiagnostic } from "../diagnostics/browser-diagnostics.ts";
import { systemClock } from "../time/clock.ts";
import type { ApiResponseSnapshot } from "./api-transport.ts";
import type { ApiCall } from "./calls/call.ts";

export class ApiConnectionError extends Error {}
export function isApiConnectionError(error: unknown): error is ApiConnectionError {
    return error instanceof ApiConnectionError;
}
export class WorkerApiTransport {
    readonly #computers = new Map<string, WsTransport>();
    readonly #origin: string;
    readonly #baselines = new Map<string, string>();
    readonly #lifetime = new AbortController();
    constructor(origin: string) {
        this.#origin = origin;
    }
    readonly dispose = (reason?: Error) => {
        this.#lifetime.abort(reason);
        for (const transport of this.#computers.values()) {
            transport.close();
        }
        this.#computers.clear();
    };
    readonly computerTransport = (computerId: string): WsTransport => {
        this.#lifetime.signal.throwIfAborted();
        if (!isIdentifier(computerId)) {
            throw new MortyValidationError("The Computer identifier is invalid");
        }
        let transport = this.#computers.get(computerId);
        if (transport === undefined) {
            transport = new WsTransport();
            this.#computers.set(computerId, transport);
        }
        return transport;
    };
    readonly #request = async (request: ApiCall): Promise<Response> => {
        const endpoint = request.endpoint;
        switch (endpoint.target.kind) {
            case "worker":
                return await fetch(endpoint.url, {
                    method: endpoint.method,
                    headers: request.headers,
                    body: request.body ?? null,
                    redirect: request.redirect ?? "follow",
                    signal: request.signal,
                });
            case "computer":
                return await this.computerTransport(endpoint.target.computerId).fetch({
                    endpoint: {
                        computerId: endpoint.target.computerId,
                        method: endpoint.method,
                        path: `${endpoint.url.pathname}${endpoint.url.search}`,
                        transport: endpoint.transport,
                        timeoutMilliseconds: endpoint.timeoutMilliseconds,
                    },
                    origin: new URL(this.#origin),
                    headers: request.headers,
                    body: request.body ?? null,
                    signal: request.signal,
                });
        }
    };
    readonly #key = (request: ApiCall) =>
        JSON.stringify([request.endpoint.url.href, request.headers["authorization"] ?? null]);
    readonly fetch = async (request: ApiCall): Promise<Response> => {
        const requestId = crypto.randomUUID();
        const started = performance.now();
        const operation = request.endpoint.operation;
        try {
            if (request.endpoint.url.origin !== this.#origin) {
                throw new Error("Unexpected Morty API origin.");
            }
            const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
            signal.throwIfAborted();
            const raw = await this.#request({ ...request, signal });
            const response = new Response(raw.body, raw);
            if (request.endpoint.watch === "snapshot") {
                this.#baselines.set(this.#key(request), `${response.status}\0${await response.clone().text()}`);
            }
            response.headers.set("x-morty-request-id", requestId);
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "worker",
                operation,
                requestId,
                elapsedMs: Math.round(performance.now() - started),
                outcome: String(response.status),
            });
            return response;
        } catch (cause) {
            recordBrowserDiagnostic({
                at: new Date().toISOString(),
                component: "worker",
                operation,
                requestId,
                elapsedMs: Math.round(performance.now() - started),
                outcome: request.signal.aborted ? "cancelled" : "error",
            });
            if (request.signal.aborted) {
                throw request.signal.reason;
            }
            this.#lifetime.signal.throwIfAborted();
            throw new ApiConnectionError("Unable to reach Morty.", { cause });
        }
    };
    readonly measureMortyLatency = async (parent: AbortSignal) => {
        const start = performance.now();
        const response = await fetch(new URL("/morty/api/v1/health", this.#origin), {
            cache: "no-store",
            signal: AbortSignal.any([parent, this.#lifetime.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) {
            throw new ApiConnectionError("Morty did not respond.");
        }
        return Math.round(performance.now() - start);
    };
    readonly waitForChange = async (request: ApiCall, ready?: (snapshot: ApiResponseSnapshot) => void) => {
        const url = request.endpoint.url;
        if (url.origin !== this.#origin || request.endpoint.watch !== "snapshot") {
            throw new Error("Invalid Morty watch request.");
        }
        const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
        let baseline = ready ? undefined : this.#baselines.get(this.#key(request));
        while (true) {
            signal.throwIfAborted();
            let response: Response;
            try {
                response = await this.#request({
                    endpoint: request.endpoint,
                    headers: request.headers,
                    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
                });
            } catch (cause) {
                signal.throwIfAborted();
                if (ready !== undefined) {
                    throw new ApiConnectionError("Unable to reach Morty.", { cause });
                }
                await systemClock.sleep(5000, signal);
                continue;
            }
            if (response.status < 500 && response.status !== 429) {
                const body = await response.text();
                signal.throwIfAborted();
                const value = `${response.status}\0${body}`;
                if (baseline !== undefined && baseline !== value) {
                    return;
                }
                if (baseline === undefined) {
                    ready?.({ status: response.status, headers: response.headers, body });
                }
                if (response.status === 401 || response.status === 403) {
                    return;
                }
                baseline = value;
            } else {
                await response.body?.cancel();
            }
            await systemClock.sleep(5000, signal);
        }
    };
}
