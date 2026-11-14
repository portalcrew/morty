import { fileURLToPath } from "node:url";
import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER, computerCredentialSuccessor } from "@morty-build/client/protocol";
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

it("answers the Computer connect request with the relay error contract when its Durable Object is unavailable", async () => {
    const { claimed } = await pairComputer();
    const response = await runtime.dispatchFetch("https://relay.test/morty/api/v1/computers/connect", {
        headers: {
            authorization: `Bearer ${text(claimed, "computerCredential")}`,
            [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: computerCredentialSuccessor(text(claimed, "computerCredential")),
            Upgrade: "websocket",
            "x-test-computer-failure": "1",
        },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: { code: "COMPUTER_OBJECT_UNAVAILABLE", message: "Morty storage is unavailable." },
    });
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
