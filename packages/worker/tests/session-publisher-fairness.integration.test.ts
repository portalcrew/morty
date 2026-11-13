import { MortyClient, WsTransport } from "@morty-build/client";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given unviewed output exceeds the live buffer, When another viewer receives an answer, Then the answer is delivered", {
    timeout: 90_000,
}, async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(20_000);
    const created = await fetch(new URL("/morty/api/v1/computers", bindings.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        }),
        signal,
    });
    const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
    await using runtime = await createControlledAgentRuntime({
        behavior: { harness: "codex", agentName: "Controlled Codex", reply: () => ({ outcome: "hold", output: [] }) },
        credential: owner.computerToken,
        computerId: owner.computerId,
        origin: bindings.origin,
        server: { request: async (request) => await fetch(request) },
        signal,
    });
    const open = (id: string) =>
        runtime.api.createConversation(
            id,
            { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
            signal,
        );
    await runtime.api.verifyAgent("codex", signal);
    const background = await open("background-fairness");
    const active = await open("active-fairness");
    const transport = new WsTransport();
    const encryptionAccess = await runtime.encryptionAccess(signal);
    const client = (credential: string) =>
        new MortyClient({
            endpoint: bindings.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: { credential: async () => credential },
            encryption: { access: encryptionAccess },
        });
    const backgroundClient = client(background.credential);
    const activeClient = client(active.credential);
    try {
        const answer = Promise.withResolvers<void>();
        let receivedAnswer = false;
        let completed = false;
        const live = await activeClient.events.subscribeLive(
            active.target,
            {
                receive: async (events) => {
                    for (const event of events) {
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text" &&
                            event.payload.content.text.includes("VISIBLE_TERMINAL_ANSWER")
                        ) {
                            receivedAnswer = true;
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            completed = true;
                            answer.resolve();
                        }
                    }
                    return true;
                },
                reconcile: async () => undefined,
            },
            signal,
        );
        try {
            await backgroundClient.turns.submit(
                background.target,
                { content: "background", attachments: [], idempotencyKey: "background-turn" },
                signal,
            );
            await runtime.continueReply("background", {
                outcome: "complete",
                output: [
                    ...Array.from({ length: 140 }, () => ({ kind: "text" as const, text: "x".repeat(256 * 1024) })),
                    ...Array.from({ length: 200 }, () => ({ kind: "text" as const, text: "x".repeat(2048) })),
                ],
            });
            const execution = await backgroundClient.sessions.readSessionExecution(
                background.target,
                signal,
                "background-turn",
            );
            expect(execution.command).toMatchObject({ state: "completed" });
            await activeClient.turns.submit(
                active.target,
                { content: "active", attachments: [], idempotencyKey: "active-turn" },
                signal,
            );
            await runtime.continueReply("active", {
                outcome: "complete",
                output: [{ kind: "text", text: `${"a".repeat(128 * 1024)}VISIBLE_TERMINAL_ANSWER` }],
            });
            await Promise.race([answer.promise, live.completed, runtime.failure]);
            expect(receivedAnswer).toBe(true);
            expect(completed).toBe(true);
        } finally {
            live.close();
        }
    } finally {
        backgroundClient.close();
        activeClient.close();
        transport.close();
    }
});
