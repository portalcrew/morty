import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    computerCredentialSuccessor,
} from "@morty-build/client/protocol";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const logs: Record<string, unknown>[] = [];
let runtime: Miniflare;

beforeAll(async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("./fixtures/relay-observability-worker.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:workers"],
        loader: { ".txt": "text", ".sql": "text" },
        format: "esm",
        platform: "browser",
        write: false,
        // Use the same JSON boundary as collected production console records.
        banner: {
            js: `for (const level of ["info", "warn", "error", "debug"]) {
                const write = console[level].bind(console);
                console[level] = (...values) => write(...values.map(value => JSON.stringify(value)));
            }`,
        },
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the observability Worker bundle");
    }
    runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-03",
            durableObjects: {
                COMPUTER_RELAY: { className: "ComputerRelay", useSQLite: true },
                UNAVAILABLE_COMPUTER: { className: "UnavailableComputer", useSQLite: true },
            },
            compatibilityFlags: ["nodejs_compat"],
            ratelimits: { ANONYMOUS_CREATION_LIMITER: { namespace_id: "103001", simple: { limit: 1000, period: 60 } } },
            bindings: {
                APP_ORIGIN: "https://relay.test",
                MORTY_ALLOWED_ORIGINS: '["*"]',
                MORTY_SESSION_SIGNING_SECRET: "local-development-only-session-signing-secret",
            },
            handleStructuredLogs: (log) => {
                const value: unknown = JSON.parse(log.message);
                if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                    logs.push(value as Record<string, unknown>);
                }
            },
        }),
    );
    await runtime.ready;
});

afterAll(async () => {
    await runtime?.dispose();
    const artifact = process.env["MORTY_LOG_E2E_ARTIFACT"];
    if (artifact !== undefined) {
        await mkdir(dirname(artifact), { recursive: true });
        await writeFile(artifact, `${JSON.stringify({ runtime: "workerd", logs }, null, 2)}\n`);
    }
});

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected an API response object");
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
    const field = record(value)[key];
    if (typeof field !== "string") {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

async function api(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    status: number,
) {
    const response = await runtime.dispatchFetch(`https://relay.test/morty/api${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...init.headers,
        },
    });
    const value: unknown = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return record(value);
}

async function provisionComputer() {
    const owner = await api(
        "/v1/computers",
        {
            method: "POST",
            body: JSON.stringify({
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
        },
        201,
    );
    return { computerId: text(owner, "computerId"), appCredential: text(owner, "computerToken") };
}

async function pairComputer() {
    const { computerId, appCredential } = await provisionComputer();
    const pairing = await api(
        `/v1/computers/${computerId}/pairing`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${appCredential}` },
            body: JSON.stringify({ idempotencyKey: "logging-computer" }),
        },
        201,
    );
    const claimed = await api(
        `/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
        {
            method: "POST",
            body: JSON.stringify({
                agents: [],
                computerName: "Logging test",
                workspaceName: "workspace",
                pairingCode: text(pairing, "pairingCode"),
            }),
        },
        200,
    );
    return { computerId, pairing, claimed };
}

let loggingComputer:
    | Promise<{
          readonly computerId: string;
          readonly connect: () => ReturnType<Miniflare["dispatchFetch"]>;
      }>
    | undefined;

/** Logging scenarios connect through the same pairing and credential rotation boundary as the Runtime. */
function registeredLoggingComputer() {
    loggingComputer ??= pairComputer().then(({ computerId, claimed }) => {
        let credential = text(claimed, "computerCredential");
        return {
            computerId,
            connect: async () => {
                const successor = computerCredentialSuccessor(credential);
                const response = await runtime.dispatchFetch("https://relay.test/morty/api/v1/computers/connect", {
                    headers: {
                        Upgrade: "websocket",
                        authorization: `Bearer ${credential}`,
                        [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: successor,
                    },
                });
                if (response.status === 101) {
                    credential = successor;
                }
                return response;
            },
        };
    });
    return loggingComputer;
}

async function httpFailure(kind: string): Promise<Record<string, unknown>> {
    const start = logs.length;
    const response = await runtime.dispatchFetch(`https://relay.test/failure/${kind}?token=QUERY_CANARY`, {
        method: "POST",
        headers: { authorization: "Bearer HEADER_CANARY", "cf-ray": "logging-test-ray" },
        body: "BODY_CANARY",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    await expect.poll(() => logs.slice(start).find((log) => log["msg"] === "Morty request failed")).toBeDefined();
    const log = logs.slice(start).find((log) => log["msg"] === "Morty request failed");
    if (log === undefined) {
        throw new Error("Expected a collected HTTP failure log");
    }
    expect(log).toMatchObject({ method: "POST", path: `/failure/${kind}`, cfRay: "logging-test-ray" });
    expect(JSON.stringify(log)).not.toMatch(/QUERY_CANARY|HEADER_CANARY|BODY_CANARY|PROPERTY_CANARY/);
    return log;
}

// @no-uc: Technical regression; Worker Error JSON serialization must retain overload diagnostics.
it("preserves nested error details and Cloudflare overload flags through the Worker HTTP log boundary", async () => {
    const log = await httpFailure("nested");
    expect(log["err"]).toMatchObject({
        name: "Error",
        message: "Computer relay request failed",
        stack: expect.stringContaining("Computer relay request failed"),
        cause: {
            message: "Too many requests queued for the same Durable Object",
            stack: expect.stringContaining("Too many requests queued"),
            overloaded: true,
            retryable: true,
            remote: true,
            code: "ERR_OVERLOADED",
        },
    });
});

// @no-uc: Technical regression; unusual throws must not break failure responses or bounded diagnostic collection.
it.each(["primitive", "object", "circular", "deep", "long", "secrets", "getter"])(
    "safely records %s failures",
    async (kind) => {
        const log = await httpFailure(kind);
        const encoded = JSON.stringify(log["err"]);
        expect(encoded.length).toBeLessThan(40_000);
        expect(encoded).not.toMatch(/PASSWORD_CANARY|URL_CANARY|ERROR_CANARY|PROPERTY_CANARY/);
        if (kind === "primitive") {
            expect(log["err"]).toMatchObject({ message: "Non-Error failure" });
        }
        if (kind === "object") {
            expect(log["err"]).toMatchObject({
                name: "RemoteFailure",
                message: "Remote queue exceeded",
                overloaded: true,
            });
        }
    },
);

// @no-uc: Technical regression; a failing DO hop must identify its target rather than only its caller.
it("identifies the failing Computer Durable Object through the public pairing and connect APIs", async () => {
    const { computerId, claimed } = await pairComputer();
    const start = logs.length;
    const response = await runtime.dispatchFetch("https://relay.test/morty/api/v1/computers/connect", {
        headers: {
            authorization: `Bearer ${text(claimed, "computerCredential")}`,
            [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: computerCredentialSuccessor(text(claimed, "computerCredential")),
            Upgrade: "websocket",
            "x-test-computer-failure": "1",
            "cf-ray": "computer-failure-ray",
        },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: { code: "COMPUTER_OBJECT_UNAVAILABLE", message: "Morty storage is unavailable." },
    });
    await expect
        .poll(() => logs.slice(start).find((log) => log["event"] === "computer_relay_request_failed"))
        .toBeDefined();
    expect(logs.slice(start)).toContainEqual(
        expect.objectContaining({
            event: "computer_relay_request_failed",
            durableObjectId: expect.any(String),
            computerId,
            path: "/morty/api/v1/computers/connect",
            cfRay: "computer-failure-ray",
            err: expect.objectContaining({ message: expect.stringContaining("Computer DO overloaded") }),
        }),
    );
});

it.each([
    { method: "GET", path: "/v1/computers/prj_ap_01_abcdefghijklmnopqrstuvwx/transport" },
    { method: "POST", path: "/v1/computers/prj_ap_01_abcdefghijklmnopqrstuvwx/pairing/redeem" },
    { method: "PUT", path: "/v1/computers/prj_ap_01_abcdefghijklmnopqrstuvwx/catalog" },
])(
    "Given an overloaded computer, When $method $path enters the production Worker, Then the relay error contract is preserved",
    async ({ method, path }) => {
        const response = await api(path, { method, headers: { "x-test-routing-failure": "1" } }, 503);
        expect(response).toEqual({
            error: { code: "COMPUTER_OBJECT_UNAVAILABLE", message: "Morty storage is unavailable." },
        });
    },
);

// @no-uc: Technical regression; computer routing failures must identify the target DO and retain overload details.
it("identifies a Computer Relay overload through the public HTTP API", async () => {
    const start = logs.length;
    const computerId = "prj_ap_01_abcdefghijklmnopqrstuvwx";
    await api(
        `/v1/computers/${computerId}`,
        { headers: { "x-test-routing-failure": "1", "cf-ray": "computer-routing-failure-ray" } },
        503,
    );
    await expect
        .poll(() => logs.slice(start).find((log) => log["event"] === "computer_relay_request_failed"))
        .toBeDefined();
    expect(logs.slice(start)).toContainEqual(
        expect.objectContaining({
            event: "computer_relay_request_failed",
            durableObjectClass: "ComputerRelay",
            durableObjectId: expect.any(String),
            computerId,
            cfRay: "computer-routing-failure-ray",
            err: expect.objectContaining({
                overloaded: true,
                message: expect.stringContaining("Computer DO overloaded"),
            }),
        }),
    );
});

async function daemon() {
    const { connect } = await registeredLoggingComputer();
    const start = logs.length;
    const response = await connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a daemon WebSocket");
    }
    const ready = new Promise((resolve) =>
        socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    socket.accept();
    try {
        await expect
            .poll(() => logs.slice(start).find((log) => log["event"] === "computer_websocket_accepted"))
            .toBeDefined();
        expect(JSON.parse(String(await ready))).toEqual({ kind: COMPUTER_LIVENESS_READY_KIND });
        return socket;
    } catch (error) {
        if (socket.readyState === 1) {
            socket.close(1000, "Test setup failed");
        }
        throw error;
    }
}

// @no-uc: Technical regression; real close callbacks must retain peer diagnostics while detach and reconnect still work.
it("records overload close details and connection epochs without logging healthy heartbeats", async () => {
    const { computerId } = await registeredLoggingComputer();
    const socket = await daemon();
    try {
        const start = logs.length;
        const heartbeat = new Promise((resolve) =>
            socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
        );
        socket.send(COMPUTER_HEARTBEAT_MESSAGE);
        expect(await heartbeat).toBe(COMPUTER_HEARTBEAT_ACK_MESSAGE);
        expect(logs.slice(start)).toHaveLength(0);
        socket.close(1013, "Service overloaded; retry later.");
        await expect
            .poll(() => logs.find((log) => log["event"] === "computer_websocket_closed" && log["closeCode"] === 1013))
            .toBeDefined();
        const closed = logs.find((log) => log["event"] === "computer_websocket_closed" && log["closeCode"] === 1013);
        expect(closed).toMatchObject({
            closeCode: 1013,
            closeReason: "Service overloaded; retry later.",
            wasClean: true,
            computerId,
            durableObjectId: expect.any(String),
            connectionEpoch: 1,
        });
        expect(logs).toContainEqual(
            expect.objectContaining({
                event: "computer_websocket_accepted",
                connectionEpoch: 1,
                computerId,
            }),
        );
        const next = await daemon();
        next.close(1000, "Test complete");
        await expect
            .poll(() =>
                logs.find((log) => log["event"] === "computer_websocket_closed" && log["connectionEpoch"] === 2),
            )
            .toBeDefined();
    } finally {
        if (socket.readyState === 1) {
            socket.close(1000, "Test cleanup");
        }
    }
});

// @no-uc: Technical regression; relay-supplied errors must survive the exported hibernatable WebSocket callback.
it("retains a relay WebSocket error and connection identity before closing the socket", async () => {
    const { computerId } = await registeredLoggingComputer();
    const socket = await daemon();
    try {
        const closed = new Promise<number>((resolve) =>
            socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
        );
        const start = logs.length;
        const responsePending = runtime.dispatchFetch(
            `https://relay.test/computers/${computerId}/inject-websocket-error`,
        );
        await expect
            .poll(() => logs.slice(start).find((log) => log["event"] === "computer_websocket_error"))
            .toBeDefined();
        socket.close(1000, "Test complete");
        const response = await responsePending;
        expect(response.status).toBe(204);
        expect(await closed).toBe(1011);
        expect(logs.slice(start)).toContainEqual(
            expect.objectContaining({
                event: "computer_websocket_error",
                connectionEpoch: expect.any(Number),
                computerId,
                durableObjectId: expect.any(String),
                err: expect.objectContaining({
                    message: "Computer relay request failed",
                    cause: expect.objectContaining({ overloaded: true }),
                }),
            }),
        );
    } finally {
        if (socket.readyState === 1) {
            socket.close(1000, "Test cleanup");
        }
    }
});
