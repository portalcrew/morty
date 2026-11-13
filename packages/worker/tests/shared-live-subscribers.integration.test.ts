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

test("Given two independently authorized viewers of one Session, when the Computer publishes one encrypted answer, then both viewers receive the same event", {
    timeout: 90_000,
}, async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = new AbortController().signal;
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
    await runtime.api.verifyAgent("codex", signal);
    const session = await runtime.api.createConversation(
        "shared-live-subscribers",
        { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
        signal,
    );
    const transport = new WsTransport();
    const access = await runtime.encryptionAccess(signal);
    const makeClient = () =>
        new MortyClient({
            endpoint: bindings.origin,
            computerId: owner.computerId,
            transport,
            credentialProvider: {
                credential: async (credentialSignal) => {
                    credentialSignal.throwIfAborted();
                    return session.credential;
                },
            },
            encryption: { access },
        });
    const firstClient = makeClient();
    const secondClient = makeClient();
    const firstAnswer = Promise.withResolvers<readonly string[]>();
    const secondAnswer = Promise.withResolvers<readonly string[]>();
    const reconciled = new Set<string>();
    try {
        const first = await firstClient.events.subscribeLive(
            session.target,
            {
                reconcile: async () => {
                    reconciled.add("first");
                },
                receive: async (events) => {
                    const matches = events.filter((event) => JSON.stringify(event).includes("SHARED_LIVE_ANSWER"));
                    if (matches.length > 0) {
                        firstAnswer.resolve(matches.map((event) => event.eventId));
                    }
                    return true;
                },
            },
            signal,
        );
        const second = await secondClient.events.subscribeLive(
            session.target,
            {
                reconcile: async () => {
                    reconciled.add("second");
                },
                receive: async (events) => {
                    const matches = events.filter((event) => JSON.stringify(event).includes("SHARED_LIVE_ANSWER"));
                    if (matches.length > 0) {
                        secondAnswer.resolve(matches.map((event) => event.eventId));
                    }
                    return true;
                },
            },
            signal,
        );
        await firstClient.turns.submit(
            session.target,
            { content: "shared", attachments: [], idempotencyKey: "shared-turn" },
            signal,
        );
        await runtime.continueReply("shared", {
            outcome: "complete",
            output: [{ kind: "text", text: "SHARED_LIVE_ANSWER" }],
        });
        const firstEvents = await Promise.race([firstAnswer.promise, first.completed]);
        const secondEvents = await Promise.race([secondAnswer.promise, second.completed]);
        expect(firstEvents).toEqual(secondEvents);
        expect(firstEvents).toHaveLength(1);
        expect(Array.from(reconciled)).toEqual(["first", "second"]);
        first.close();
        second.close();
    } finally {
        firstClient.close();
        secondClient.close();
        transport.close();
    }
});
