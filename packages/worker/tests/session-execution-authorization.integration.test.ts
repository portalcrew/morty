import { createClientPayloadEncryption, MortyClient, sessionEndpoints, WsTransport } from "@morty-build/client";
import { decodeSessionReadyEvent, nativeSessionCommandCodec } from "@morty-build/client/protocol";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-13T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given Session access and Computer encryption access, When a caller sends a native mutation to the execution-read endpoint, Then it is refused without creating a Session and execution reads remain usable", {
    timeout: 90_000,
}, async () => {
    const createBindings = await prepareTestMortyRelayBindings();
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(60_000);
    const created = await fetch(new URL("/morty/api/v1/computers", bindings.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        }),
        signal,
    });
    expect(created.status).toBe(201);
    const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
    await using runtime = await createControlledAgentRuntime({
        behavior: {
            harness: "codex",
            agentName: "Controlled Codex",
            reply: () => ({ outcome: "complete", output: [] }),
        },
        credential: owner.computerToken,
        computerId: owner.computerId,
        origin: bindings.origin,
        server: { request: async (input) => await fetch(input) },
        signal,
    });
    const encryptionAccess = await runtime.encryptionAccess(signal);
    const ownerClient = createOwnerApi({
        origin: bindings.origin,
        computerId: owner.computerId,
        credential: owner.computerToken,
        encryptionAccess,
    });
    const encryption = await createClientPayloadEncryption(encryptionAccess, signal);
    const transport = new WsTransport();
    try {
        const access = await ownerClient.api.createConversation(
            "execution-read-authorization",
            { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
            signal,
        );
        const ready = decodeSessionReadyEvent(JSON.stringify(access.ready));
        const client = new MortyClient({
            endpoint: bindings.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => access.credential },
            encryption: { access: encryptionAccess },
        });
        try {
            const mutations: readonly ("fork" | "import")[] = ["fork", "import"];
            for (const action of mutations) {
                const body = await nativeSessionCommandCodec.encode(
                    {
                        action,
                        directory: ready.directory,
                        harness: ready.target.harness,
                        kind: "native.session.request",
                        requestId: `execution-read-${action}`,
                        sessionId: ready.target.sessionId,
                    },
                    encryption,
                    signal,
                );
                const response = await transport.fetch({
                    endpoint: sessionEndpoints.readExecution({ computerId: owner.computerId, target: ready.target }),
                    origin: new URL("/morty/api/", bindings.origin),
                    headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
                    body,
                    signal,
                });
                expect(response.status).toBe(400);
                expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
            }
            const sessions = await ownerClient.api.managedSessions(signal);
            expect(sessions).toMatchObject([{ target: ready.target }]);
            expect(sessions).toHaveLength(1);
            await client.sessions.readSessionExecution(ready.target, signal);
        } finally {
            client.close();
        }
    } finally {
        transport.close();
        encryption.close();
        ownerClient.close();
    }
});
