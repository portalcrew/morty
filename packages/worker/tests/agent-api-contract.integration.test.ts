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
