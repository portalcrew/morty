import { MortyClient, WsTransport } from "@morty-build/client";
import { decodeSessionReadyEvent, fileReadCommandCodec } from "@morty-build/client/protocol";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";
import { recordingRelay } from "./support/recording-relay.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given a slow file download, When the browser stops reading and cancels, Then the Computer sends only credited chunks and unrelated Session work remains usable", {
    timeout: 90_000,
}, async () => {
    await using bindings = await createBindings();
    await using network = await recordingRelay(bindings.origin);
    await bindings.configure({ APP_ORIGIN: network.origin });
    const signal = AbortSignal.timeout(60_000);
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
            files: new Map([
                [
                    "/workspace/slow-download.bin",
                    { content: "x".repeat(16 * 1024 * 1024), mediaType: "application/octet-stream" },
                ],
            ]),
            reply: () => ({ outcome: "complete", output: [] }),
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
        encryptionAccess: await runtime.encryptionAccess(signal),
    });
    try {
        const access = await ownerClient.api.createConversation(
            "slow-download-session",
            { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
            signal,
        );
        const target = decodeSessionReadyEvent(JSON.stringify(access.ready)).target;
        const transport = new WsTransport();
        const client = new MortyClient({
            endpoint: network.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => access.credential },
            encryption: { access: await runtime.encryptionAccess(signal) },
        });
        try {
            const start = network.frames.length;
            const gate = network.pauseNextDownload();
            const path = `/morty/api/v1/computers/${owner.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/files/content`;
            const response = await fetch(new URL(path, network.origin), {
                body: await fileReadCommandCodec.encode(
                    {
                        kind: "file.read",
                        maxBytes: 16 * 1024 * 1024,
                        path: "slow-download.bin",
                        requestId: crypto.randomUUID(),
                        target,
                    },
                    transport.payloadEncryption,
                    signal,
                ),
                headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
                method: "POST",
                signal,
            });
            expect(response.status).toBe(200);
            if (response.body === null) {
                throw new Error("Expected the encrypted file stream");
            }
            const reader = response.body.getReader();
            try {
                await gate.entered;
                const first = await network.waitForFrame(
                    start,
                    (frame) =>
                        (frame.direction === "relay-to-daemon" && frame.data.includes('"kind":"worker.file.credit"')) ||
                        (frame.direction === "daemon-to-relay" && frame.data.startsWith("MBC1")),
                    signal,
                );
                expect(first.direction).toBe("relay-to-daemon");
                const credit = v.parse(
                    v.object({ kind: v.literal("worker.file.credit"), requestId: v.string(), chunks: v.literal(1) }),
                    JSON.parse(first.data),
                );
                expect((await reader.read()).done).toBe(false);
                // This response crosses the same daemon connection after the downstream sink has stopped.
                await client.sessions.readConfiguration(target, signal);
                let creditsBeforeCancel = 0;
                let chunksBeforeCancel = 0;
                for (const frame of network.frames.slice(start)) {
                    if (
                        frame.direction === "relay-to-daemon" &&
                        frame.data.includes('"kind":"worker.file.credit"') &&
                        frame.data.includes(credit.requestId)
                    ) {
                        creditsBeforeCancel += 1;
                        expect(creditsBeforeCancel - chunksBeforeCancel).toBeLessThanOrEqual(1);
                    }
                    if (frame.direction === "daemon-to-relay" && frame.data.startsWith("MBC1")) {
                        chunksBeforeCancel += 1;
                        expect(chunksBeforeCancel).toBeLessThanOrEqual(creditsBeforeCancel);
                    }
                }
                // TCP and fetch may buffer ahead of the paused sink, but cannot consume the file.
                expect(chunksBeforeCancel).toBeLessThanOrEqual(32);
                const cancellation = network.waitForFrame(
                    start,
                    (frame) =>
                        frame.direction === "relay-to-daemon" &&
                        frame.data.includes('"kind":"worker.request.cancel"') &&
                        frame.data.includes(credit.requestId),
                    signal,
                );
                await reader.cancel();
                await cancellation;
                await client.sessions.readConfiguration(target, signal);
                const afterCancellationBarrier = network.frames.length;
                await client.sessions.readConfiguration(target, signal);
                expect(
                    network.frames
                        .slice(afterCancellationBarrier)
                        .filter((frame) => frame.direction === "daemon-to-relay" && frame.data.startsWith("MBC1")),
                ).toHaveLength(0);
                let credits = 0;
                let chunks = 0;
                for (const frame of network.frames.slice(start)) {
                    if (
                        frame.direction === "relay-to-daemon" &&
                        frame.data.includes('"kind":"worker.file.credit"') &&
                        frame.data.includes(credit.requestId)
                    ) {
                        credits += 1;
                    }
                    if (frame.direction === "daemon-to-relay" && frame.data.startsWith("MBC1")) {
                        chunks += 1;
                        expect(chunks).toBeLessThanOrEqual(credits);
                    }
                }
                expect(chunks).toBeLessThan(Math.ceil((16 * 1024 * 1024) / (192 * 1024)));
                const complete = await client.sessions.readFile(target, "slow-download.bin", signal);
                expect(complete.bytes.byteLength).toBe(16 * 1024 * 1024);
                expect(complete.bytes[0]).toBe("x".charCodeAt(0));
                expect(complete.bytes[complete.bytes.byteLength - 1]).toBe("x".charCodeAt(0));
            } finally {
                gate.release();
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        } finally {
            client.close();
            transport.close();
        }
    } finally {
        ownerClient.close();
    }
});
