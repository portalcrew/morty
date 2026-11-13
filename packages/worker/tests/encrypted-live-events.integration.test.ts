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

test("Given a valid large tool event, When it is published live, Then the client receives it and another Session remains usable", {
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
    const blocks = Array.from({ length: 8 }, (_, index) => `block-${index}:${"x".repeat(900_000)}`);
    await using runtime = await createControlledAgentRuntime({
        behavior: {
            harness: "codex",
            agentName: "Controlled Codex",
            reply: (prompt) =>
                prompt === "large tool"
                    ? {
                          outcome: "complete",
                          output: [
                              {
                                  kind: "activity",
                                  activityType: "tool",
                                  title: "Large tool",
                                  output: "done",
                                  content: blocks.map((text) => ({ type: "content", content: { type: "text", text } })),
                              },
                          ],
                      }
                    : { outcome: "complete", output: [{ kind: "text", text: "other Session works" }] },
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
    const otherTransport = new WsTransport();
    try {
        const options = { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." };
        const access = await ownerClient.api.createConversation("large-live-tool", options, signal);
        const otherAccess = await ownerClient.api.createConversation("unrelated-live", options, signal);
        const target = decodeSessionReadyEvent(JSON.stringify(access.ready)).target;
        const otherTarget = decodeSessionReadyEvent(JSON.stringify(otherAccess.ready)).target;
        const client = new MortyClient({
            endpoint: network.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => access.credential },
            encryption: { access: encryptionAccess },
        });
        const other = new MortyClient({
            endpoint: network.origin,
            computerId: owner.computerId,
            transport: otherTransport,
            credentialProvider: { credential: async () => otherAccess.credential },
            encryption: { access: encryptionAccess },
        });
        try {
            const received = Promise.withResolvers<readonly string[]>();
            const finished = Promise.withResolvers<void>();
            const live = await client.events.subscribeLive(
                target,
                {
                    reconcile: async () => undefined,
                    receive: async (events) => {
                        for (const event of events) {
                            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                                finished.resolve();
                            }
                            if (
                                event.type === "acp" &&
                                event.payload.sessionUpdate === "tool_call" &&
                                event.payload.title === "Large tool"
                            ) {
                                const contents = event.payload.content ?? [];
                                received.resolve(
                                    contents.map((item) =>
                                        item.type === "content" && item.content.type === "text"
                                            ? item.content.text
                                            : "unexpected",
                                    ),
                                );
                            }
                        }
                        return true;
                    },
                },
                signal,
            );
            try {
                const start = network.frames.length;
                await client.turns.submit(
                    target,
                    { content: "large tool", attachments: [], idempotencyKey: "large-tool-turn" },
                    signal,
                );
                const result = await Promise.race([
                    received.promise,
                    live.completed.then(() => {
                        throw new Error("Live stream closed before tool event");
                    }),
                    runtime.failure,
                    network.failure,
                ]);
                expect(result).toEqual(blocks);
                await Promise.race([
                    finished.promise,
                    live.completed.then(() => {
                        throw new Error("Live stream closed before prompt completion");
                    }),
                    runtime.failure,
                    network.failure,
                ]);
                const frames = network.frames
                    .slice(start)
                    .filter(
                        (frame) =>
                            frame.direction === "daemon-to-relay" && frame.data.includes('"kind":"session.event.v2"'),
                    );
                const sizes = frames.map((frame) => Buffer.byteLength(frame.data));
                expect(sizes.some((size) => size > 8 * 1024 * 1024 && size <= 12 * 1024 * 1024)).toBe(true);
                let cursor = "";
                let historyTool: readonly string[] | undefined;
                do {
                    const page = await client.events.list(target, new MortyPageRequest(100, cursor), signal);
                    for (const event of page.events) {
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "tool_call" &&
                            event.payload.title === "Large tool"
                        ) {
                            historyTool = (event.payload.content ?? []).map((item) =>
                                item.type === "content" && item.content.type === "text"
                                    ? item.content.text
                                    : "unexpected",
                            );
                        }
                    }
                    cursor = page.nextCursor ?? "";
                } while (cursor !== "");
                expect(historyTool).toEqual(blocks);
                const turn = await other.turns.submit(
                    otherTarget,
                    { content: "other", attachments: [], idempotencyKey: "other-turn" },
                    signal,
                );
                expect(turn.turnId).toBe("other-turn");
                await other.sessions.readConfiguration(otherTarget, signal);
            } finally {
                live.close();
            }
        } finally {
            client.close();
            other.close();
        }
    } finally {
        transport.close();
        otherTransport.close();
        ownerClient.close();
    }
});
