import { MortyClient, MortyPageRequest, WsTransport } from "@morty-build/client";
import {
    CONTENT_WRITE_MAX_BYTES,
    decodeSessionReadyEvent,
    sessionPromptAcceptedEventCodec,
    sessionPromptCommandCodec,
} from "@morty-build/client/protocol";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, onTestFailed, onTestFinished, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";
import { recordingRelay } from "./support/recording-relay.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});

test("Given an attachment within the supported plaintext limit, when its encrypted upload exceeds the ordinary transport limit, then the Computer accepts it and larger plaintext is rejected", {
    timeout: 90_000,
}, async () => {
    await using bindings = await createBindings();
    await using network = await recordingRelay(bindings.origin);
    await bindings.configure({ APP_ORIGIN: network.origin });
    const signal = AbortSignal.timeout(75_000);
    const created = await fetch(new URL("/morty/api/v1/computers", network.origin), {
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
        origin: network.origin,
        server: { request: async (input) => await fetch(input) },
        signal,
    });
    const encryptionAccess = await runtime.encryptionAccess(signal);
    const ownerClient = createOwnerApi({
        origin: network.origin,
        computerId: owner.computerId,
        credential: owner.computerToken,
        request: async (request) => await fetch(request),
        encryptionAccess,
    });
    const transport = new WsTransport();
    try {
        await ownerClient.api.verifyAgent("codex", signal);
        const access = await ownerClient.api.createConversation(
            "large-encrypted-upload",
            {
                harness: "codex",
                configurations: [],
                workspaceRef: ".",
                workspaceLabel: ".",
            },
            signal,
        );
        const client = new MortyClient({
            endpoint: network.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => access.credential },
            encryption: { access: encryptionAccess },
        });
        try {
            const bytes = new Uint8Array(10 * 1024 * 1024).fill(0x5a);
            const contentKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
                byte.toString(16).padStart(2, "0"),
            ).join("");
            const input: Parameters<typeof client.sessions.uploadContent>[1] = {
                bytes,
                contentKey,
                kind: "resource",
                mediaType: "application/octet-stream",
                name: "large.bin",
                uri: "file:///large.bin",
            };
            await expect(
                client.sessions.uploadContent(
                    access.target,
                    { ...input, bytes: new Uint8Array(CONTENT_WRITE_MAX_BYTES + 1) },
                    signal,
                ),
            ).rejects.toMatchObject({ code: "invalid_request" });
            expect(await client.sessions.uploadContent(access.target, input, signal)).toMatchObject({
                contentKey,
                byteLength: bytes.byteLength,
            });
            const declarations = network.frames
                .filter((frame) => frame.direction === "client-to-relay" && frame.data.startsWith("{"))
                .map((frame) =>
                    v.safeParse(
                        v.object({
                            kind: v.string(),
                            path: v.optional(v.string()),
                            bodyByteLength: v.optional(v.number()),
                        }),
                        JSON.parse(frame.data),
                    ),
                )
                .filter(
                    (parsed) =>
                        parsed.success &&
                        parsed.output.kind === "http.request" &&
                        parsed.output.path?.includes(`/content/${contentKey}`),
                );
            expect(declarations).toHaveLength(1);
            const declaration = declarations[0];
            if (declaration === undefined || !declaration.success || declaration.output.bodyByteLength === undefined) {
                throw new Error("Expected the binary upload declaration");
            }
            expect(declaration.output.bodyByteLength).toBeGreaterThan(12 * 1024 * 1024);
        } finally {
            client.close();
        }
    } finally {
        transport.close();
        ownerClient.close();
    }
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given a paired Computer, when its owner selects an Agent, then setup receives the Agent settings reply addressed by its public request identity", {
    timeout: 45_000,
}, async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(35_000);
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
    const client = createOwnerApi({
        origin: bindings.origin,
        computerId: owner.computerId,
        credential: owner.computerToken,
        request: async (request) => await fetch(request),
        encryptionAccess: await runtime.encryptionAccess(signal),
    });
    try {
        await expect(client.api.verifyAgent("codex", signal)).resolves.toBeUndefined();
        const diagnostic = await client.api.networkDiagnostic(signal);
        expect(diagnostic.computerLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
        client.close();
    }
});

test("Given a locally paired encrypted client, when it submits a prompt and reads the answer, then the real daemon executes it while both relay legs carry only ciphertext", {
    timeout: 90_000,
}, async () => {
    await using bindings = await createBindings();
    await using network = await recordingRelay(bindings.origin);
    onTestFailed(() => {
        console.error(
            "Daemon reply routing observed by the recording relay",
            network.frames
                .filter((frame) => frame.direction === "daemon-to-relay" && frame.data.startsWith("{"))
                .slice(-8)
                .map((frame) => {
                    const reply = v.parse(
                        v.object({
                            kind: v.string(),
                            requestId: v.optional(v.string()),
                            commandId: v.optional(v.string()),
                            target: v.optional(v.unknown()),
                        }),
                        JSON.parse(frame.data),
                    );
                    return reply;
                }),
        );
    });
    await bindings.configure({ APP_ORIGIN: network.origin });
    const signal = AbortSignal.timeout(60_000);
    const request = async (path: string, body: unknown, credential?: string) => {
        const response = await fetch(new URL(`/morty/api/v1${path}`, network.origin), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
            },
            body: JSON.stringify(body),
            signal,
        });
        expect(response.ok, await response.clone().text()).toBe(true);
        return await response.json();
    };
    const owner = v.parse(
        v.object({ computerId: v.string(), computerToken: v.string() }),
        await request("/computers", {
            creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        }),
    );
    await using runtime = await createControlledAgentRuntime({
        behavior: {
            files: new Map([
                ["/workspace/private.txt", { content: "secret file e2e-acceptance", mediaType: "text/plain" }],
            ]),
            harness: "codex",
            agentName: "Controlled Codex",
            reply: () => ({ outcome: "complete", output: [{ kind: "text", text: "secret answer e2e-acceptance" }] }),
        },
        credential: owner.computerToken,
        computerId: owner.computerId,
        origin: network.origin,
        server: { request: async (input) => await fetch(input) },
        signal,
    });
    const ownerClient = createOwnerApi({
        origin: network.origin,
        computerId: owner.computerId,
        credential: owner.computerToken,
        request: async (request) => await fetch(request),
        encryptionAccess: await runtime.encryptionAccess(signal),
    });
    onTestFinished(() => ownerClient.close());
    await ownerClient.api.verifyAgent("codex", signal);
    const access = await ownerClient.api.createConversation(
        "encrypted-conversation",
        {
            harness: "codex",
            configurations: [],
            workspaceRef: ".",
            workspaceLabel: ".",
        },
        signal,
    );
    const ready = decodeSessionReadyEvent(JSON.stringify(access.ready));
    const transport = new WsTransport();
    const clientOptions = {
        endpoint: network.origin,
        computerId: owner.computerId,
        transport,
        credentialProvider: { credential: async () => access.credential },
        encryption: { access: await runtime.encryptionAccess(signal) },
    };
    const client = new MortyClient(clientOptions);
    try {
        const answered = Promise.withResolvers<void>();
        const output: string[] = [];
        const live = await client.events.subscribeLive(
            ready.target,
            {
                reconcile: async () => undefined,
                receive: async (events) => {
                    for (const event of events) {
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            output.push(event.payload.content.text);
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            answered.resolve();
                        }
                    }
                    return true;
                },
            },
            signal,
        );
        try {
            const turn = await client.turns.submit(
                ready.target,
                { content: "secret prompt e2e-acceptance", attachments: [], idempotencyKey: "encrypted-turn" },
                signal,
            );
            expect(turn.turnId).toBe("encrypted-turn");
            await Promise.race([answered.promise, live.completed, runtime.failure, network.failure]);
            expect(output.join("")).toBe("secret answer e2e-acceptance");
            const page = await client.events.list(ready.target, new MortyPageRequest(100, ""), signal);
            expect(JSON.stringify(page)).toContain("secret answer e2e-acceptance");
            const file = await client.sessions.readFile(ready.target, "private.txt", signal);
            expect(new TextDecoder().decode(file.bytes)).toBe("secret file e2e-acceptance");
            const uploadedBytes = new TextEncoder().encode("secret upload e2e-acceptance");
            const contentKey = Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", uploadedBytes)),
                (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            const attachment = await client.sessions.uploadContent(
                ready.target,
                {
                    bytes: uploadedBytes,
                    contentKey,
                    kind: "resource",
                    mediaType: "text/plain",
                    name: "private-upload.txt",
                    uri: "file:///private-upload.txt",
                },
                signal,
            );
            expect(attachment.contentKey).toBe(contentKey);
            expect(attachment.byteLength).toBe(uploadedBytes.byteLength);
            const separatelyAddressed = await sessionPromptCommandCodec.encode(
                {
                    kind: "session.prompt",
                    requestId: "encrypted-request-address",
                    commandId: "separate-turn-identity",
                    target: ready.target,
                    prompt: "secret prompt e2e-acceptance",
                    attachments: [attachment],
                    disposition: "append",
                },
                transport.payloadEncryption,
                signal,
            );
            const acceptedResponse = await transport.fetch({
                endpoint: {
                    computerId: owner.computerId,
                    method: "POST",
                    path: `/morty/api/v1/computers/${owner.computerId}/harnesses/${ready.target.harness}/sessions/${ready.target.sessionId}/turns`,
                    transport: { kind: "websocket", cancellation: "local" },
                    timeoutMilliseconds: 20_000,
                },
                origin: new URL(network.origin),
                headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
                body: separatelyAddressed,
                signal,
            });
            expect(acceptedResponse.status).toBe(200);
            const separatelyAccepted = await sessionPromptAcceptedEventCodec.decode(
                await acceptedResponse.text(),
                transport.payloadEncryption,
                signal,
            );
            expect(separatelyAccepted.requestId).toBe("encrypted-request-address");
        } finally {
            live.close();
        }
        for (const { data } of network.frames) {
            expect(data).not.toContain("secret prompt e2e-acceptance");
            expect(data).not.toContain("secret answer e2e-acceptance");
            expect(data).not.toContain("secret file e2e-acceptance");
            expect(data).not.toContain("secret upload e2e-acceptance");
        }
        for (const direction of ["client-to-relay", "relay-to-daemon", "daemon-to-relay", "relay-to-client"]) {
            const messages = network.frames
                .filter((frame) => frame.direction === direction && frame.data.startsWith("{"))
                .map((frame) => {
                    const outer = v.parse(v.object({ kind: v.optional(v.string()) }), JSON.parse(frame.data));
                    if (outer.kind === "http.request") {
                        return v.parse(v.object({ body: v.string() }), JSON.parse(frame.data)).body;
                    }
                    if (outer.kind === "session.events.event") {
                        return v.parse(v.object({ data: v.string() }), JSON.parse(frame.data)).data;
                    }
                    return frame.data;
                })
                .filter(
                    (encoded) =>
                        encoded.includes('"kind":"session.prompt"') || encoded.includes('"kind":"session.event.v2"'),
                );
            expect(messages.length, direction).toBeGreaterThan(0);
            for (const message of messages) {
                const wire = v.parse(v.object({ kind: v.string(), encrypted: v.string() }), JSON.parse(message));
                expect(wire.encrypted.length).toBeGreaterThan(0);
                expect(message).not.toContain('"header":');
                expect(message).not.toContain('"payload":');
                expect(message).not.toContain('"channelId":');
            }
        }
    } finally {
        client.close();
        transport.close();
    }
});
