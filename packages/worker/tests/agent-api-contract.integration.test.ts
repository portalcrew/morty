import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { connectComputerApiWebSocket } from "./support/computer-api-websocket.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

const documentSchema = v.object({
    paths: v.record(
        v.string(),
        v.record(
            v.string(),
            v.object({ operationId: v.string(), "x-morty-transport": v.optional(v.literal("websocket")) }),
        ),
    ),
});

test("Given the agent OpenAPI document, when a peer reads encrypted Session operations, then request and response schemas describe the wire envelopes", async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const response = await bindings.request(new Request(`${bindings.origin}/doc/agent-api/openapi.json`));
    expect(response.status).toBe(200);
    const document = v.parse(
        v.object({ paths: v.record(v.string(), v.record(v.string(), v.unknown())) }),
        await response.json(),
    );
    const session = "/morty/api/v1/computers/{computerId}/harnesses/{harness}/sessions/{sessionId}";
    const operation = (path: string, method: string) =>
        v.parse(
            v.object({
                requestBody: v.object({
                    required: v.literal(true),
                    content: v.object({ "application/json": v.object({ schema: v.unknown() }) }),
                }),
                responses: v.object({
                    "200": v.object({ content: v.object({ "application/json": v.object({ schema: v.unknown() }) }) }),
                }),
            }),
            document.paths[path]?.[method],
        );
    for (const [path, method, requestKind, replyKind] of [
        [`${session}/active-turn`, "get", "native.session.request", "native.session.result"],
        [`${session}/events`, "get", "session.live-history.v2.page.load", "session.live-history.v2.page.loaded"],
        [`${session}/configuration`, "get", "session.config.read", "session.config.read.result"],
        [`${session}/turns`, "post", "session.prompt", "session.prompt.accepted"],
        [`${session}/turns/{turnId}/cancel`, "post", "session.cancel", "session.turn.stopped"],
    ] as const) {
        const item = operation(path, method);
        const request = JSON.stringify(item.requestBody.content["application/json"].schema);
        const reply = JSON.stringify(item.responses["200"].content["application/json"].schema);
        expect(request).toContain('"encrypted"');
        expect(request).toContain('"requestId"');
        expect(request).toContain(requestKind);
        expect(request).not.toContain('"idempotencyKey"');
        expect(reply).toContain('"encrypted"');
        expect(reply).toContain(replyKind);
        expect(reply).toContain("session.operation.failed");
        expect(reply).not.toContain('"prompt"');
    }
    const chat = "/morty/api/v1/computers/{computerId}";
    const continuation = operation(`${chat}/native-sessions/continue`, "post");
    expect(JSON.stringify(continuation.requestBody)).toContain('"find"');
    expect(JSON.stringify(continuation.requestBody)).toContain('"import"');
    expect(JSON.stringify(continuation.responses)).toContain('"native.session.result"');
    const opened = operation(`${chat}/managed-sessions/open`, "post");
    expect(JSON.stringify(opened.responses)).toContain('"session.ready"');
    expect(JSON.stringify(opened.responses)).toContain('"credential"');
    expect(JSON.stringify(opened.responses)).toContain('"encrypted"');
    const renewed = operation(`${chat}/native-sessions/access`, "post");
    expect(JSON.stringify(renewed.requestBody)).toContain('"session.prepare"');
    expect(JSON.stringify(renewed.responses)).toContain('"credential"');
    expect(JSON.stringify(renewed.responses)).toContain('"session.operation.failed"');
});

test("Given the agent transport description, when a remote agent reads the request body instructions, then it is told that GET requests carry encrypted bodies", async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const response = await bindings.request(new Request(`${bindings.origin}/doc/agent-api/asyncapi.json`));
    expect(response.status).toBe(200);
    const document = v.parse(
        v.object({
            channels: v.object({
                transport: v.object({
                    messages: v.object({
                        httpRequest: v.object({
                            payload: v.object({
                                properties: v.object({ body: v.object({ description: v.string() }) }),
                            }),
                        }),
                    }),
                }),
            }),
        }),
        await response.json(),
    );
    expect(document.channels.transport.messages.httpRequest.payload.properties.body.description).toContain("GET");
    expect(document.channels.transport.messages.httpRequest.payload.properties.body.description).toContain("encrypted");
    expect(document.channels.transport.messages.httpRequest.payload.properties.body.description).not.toContain(
        '"" for GET',
    );
});

test("Given the generated agent API description, When a peer sends every documented operation as described, Then HTTP operations reach their Worker routes and WebSocket operations reach the Session routes", async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(45_000);
    const created = await bindings.request(
        new Request(`${bindings.origin}/morty/api/v1/computers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
            signal,
        }),
    );
    expect(created.status).toBe(201);
    const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
    const described = await bindings.request(new Request(`${bindings.origin}/doc/agent-api/openapi.json`, { signal }));
    expect(described.status).toBe(200);
    const document = v.parse(documentSchema, await described.json());
    const transport = await connectComputerApiWebSocket(bindings.origin, owner.computerId, signal);
    try {
        const reached: string[] = [];
        for (const [path, methods] of Object.entries(document.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
                const concrete = path
                    .replace("{computerId}", owner.computerId)
                    .replaceAll(/\{[a-zA-Z]+\}/gu, "documented-id");
                const request = new Request(`${bindings.origin}${concrete}`, {
                    method: method.toUpperCase(),
                    headers: { authorization: `Bearer ${owner.computerToken}`, "content-type": "application/json" },
                    ...(method === "get" ? {} : { body: "{}" }),
                    signal,
                });
                const response =
                    operation["x-morty-transport"] === "websocket"
                        ? await transport.fetch(request)
                        : await bindings.request(request);
                const answer = v.parse(
                    v.object({ error: v.optional(v.object({ code: v.string() })) }),
                    await response.json().catch(() => ({})),
                );
                // A route that exists refuses the placeholder input or credential; only a missing route answers not found.
                expect(response.status === 404 && answer.error?.code === "not_found", operation.operationId).toBe(
                    false,
                );
                expect(response.status === 404 && answer.error?.code === "NOT_FOUND", operation.operationId).toBe(
                    false,
                );
                reached.push(operation.operationId);
            }
        }
        expect(reached).toEqual(
            expect.arrayContaining([
                "redeemTransfer",
                "openSession",
                "readActiveTurn",
                "submitTurn",
                "listSessionEvents",
            ]),
        );
    } finally {
        transport.close();
    }
});
