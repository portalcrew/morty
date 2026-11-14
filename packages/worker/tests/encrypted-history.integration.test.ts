import { MortyClient, MortyPageRequest, WsTransport } from "@morty-build/client";
import { decodeSessionReadyEvent } from "@morty-build/client/protocol";
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

test("Given large valid history events, When the client reads all pages, Then every event is returned once without disconnecting the Computer", {
    timeout: 120_000,
}, async () => {
    await using bindings = await createBindings();
    await using network = await recordingRelay(bindings.origin);
    await bindings.configure({ APP_ORIGIN: network.origin });
    const signal = AbortSignal.timeout(90_000);
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
    const texts = Array.from(
        { length: 10 },
        (_, index) =>
            `large-event-${index}:${index === 0 ? `${'\\"é'.repeat(30_000)}${"x".repeat(810_000)}` : "x".repeat(900_000)}`,
    );
    await using runtime = await createControlledAgentRuntime({
        behavior: {
            harness: "codex",
            agentName: "Controlled Codex",
            reply: () => ({ outcome: "complete", output: texts.map((text) => ({ kind: "text", text })) }),
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
        encryptionAccess,
    });
    const transport = new WsTransport();
    try {
        const access = await ownerClient.api.createConversation(
            "large-history",
            { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
            signal,
        );
        const target = decodeSessionReadyEvent(JSON.stringify(access.ready)).target;
        const client = new MortyClient({
            endpoint: network.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => access.credential },
            encryption: { access: encryptionAccess },
        });
        try {
            const done = Promise.withResolvers<void>();
            const live = await client.events.subscribeLive(
                target,
                {
                    reconcile: async () => undefined,
                    receive: async (events) => {
                        if (
                            events.some(
                                (event) =>
                                    event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                            )
                        ) {
                            done.resolve();
                        }
                        return true;
                    },
                },
                signal,
            );
            try {
                await client.turns.submit(
                    target,
                    { content: "create large history", attachments: [], idempotencyKey: "large-history-turn" },
                    signal,
                );
                await Promise.race([done.promise, live.completed, runtime.failure, network.failure]);
                const start = network.frames.length;
                let cursor = "";
                const found: string[] = [];
                const cursors = new Set<string>();
                const eventIds = new Set<string>();
                do {
                    const page = await client.events.list(target, new MortyPageRequest(100, cursor), signal);
                    for (const event of page.events) {
                        expect(eventIds.has(event.eventId)).toBe(false);
                        eventIds.add(event.eventId);
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            found.push(event.payload.content.text);
                        }
                    }
                    cursor = page.nextCursor ?? "";
                    if (cursor !== "") {
                        expect(cursors.has(cursor)).toBe(false);
                        cursors.add(cursor);
                    }
                } while (cursor !== "");
                expect(found.toSorted()).toEqual(texts.toSorted());
                expect(cursors.size).toBeGreaterThan(0);
                const historyFrames = network.frames
                    .slice(start)
                    .filter(
                        (frame) =>
                            frame.direction === "daemon-to-relay" &&
                            frame.data.includes('"kind":"session.live-history.v2.page.loaded"'),
                    );
                expect(historyFrames.length).toBeGreaterThan(1);
                for (const frame of historyFrames) {
                    expect(Buffer.byteLength(frame.data)).toBeLessThanOrEqual(12 * 1024 * 1024);
                }
                await client.sessions.readConfiguration(target, signal);
            } finally {
                live.close();
            }
        } finally {
            client.close();
        }
    } finally {
        transport.close();
        ownerClient.close();
    }
});
