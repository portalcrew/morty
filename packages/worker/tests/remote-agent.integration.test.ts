import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerEncryptionAccessCodec } from "@morty-build/client";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { expect, onTestFinished, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../tests/support/owner-api.ts";
import type { runSharedComputer } from "../../web/src/services/remote-agent.ts";

const scenario =
    "Given a shared Computer with $history, when its served helper runs, then it returns the requested answer";
test.each([
    { history: "short history", olderChunks: 0 },
    { history: "long history exceeding 100 pages", olderChunks: 10_001 },
])(scenario, { timeout: 90_000 }, async ({ olderChunks }) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-13T00:00:00Z") });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const createBindings = await prepareTestMortyRelayBindings();
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(75_000);
    const created = await fetch(new URL("/morty/api/v1/computers", bindings.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        }),
        signal,
    });
    const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
    const nativeId = crypto.randomUUID();
    const held = Promise.withResolvers<void>();
    await using runtime = await createControlledAgentRuntime({
        behavior: {
            harness: "codex",
            agentName: "Controlled Codex",
            sessionIds: new Set([nativeId]),
            reply: (prompt) => {
                if (prompt === "Earlier turn") {
                    return {
                        outcome: "complete",
                        output: Array.from({ length: olderChunks }, () => ({ kind: "message", text: "old answer" })),
                    };
                }
                if (prompt === "Wait") {
                    held.resolve();
                    return { outcome: "hold", output: [] };
                }
                return { outcome: "complete", output: [{ kind: "text", text: "remote answer" }] };
            },
        },
        credential: owner.computerToken,
        computerId: owner.computerId,
        origin: bindings.origin,
        server: { request: async (input) => await fetch(input) },
        signal,
    });
    const share = await fetch(
        new URL(`/morty/api/v1/computers/${owner.computerId}/identity/transfers`, bindings.origin),
        {
            method: "POST",
            headers: { authorization: `Bearer ${owner.computerToken}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
            signal,
        },
    );
    const link = new URL(v.parse(v.object({ url: v.string() }), await share.json()).url);
    const fragment = new URLSearchParams(link.hash.slice(1));
    fragment.set(
        "e2e",
        Buffer.from(computerEncryptionAccessCodec.encode(await runtime.encryptionAccess(signal))).toString("base64url"),
    );
    link.hash = fragment.toString();
    const document = await fetch(new URL("/doc/agent-api.md", bindings.origin), { signal });
    const text = await document.text();
    const bundle = /```js morty-remote-agent\n([\s\S]*?)\n```/u.exec(text)?.[1];
    expect(bundle).toBeDefined();
    if (bundle === undefined) {
        throw new Error("Missing served helper");
    }
    const module: unknown = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
    const helper = v.parse(
        v.object({ runSharedComputer: v.custom<typeof runSharedComputer>((value) => typeof value === "function") }),
        module,
    );
    const input = {
        link: link.href,
        redemptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        conversationKey: "remote-conversation",
        turnId: "remote-turn",
        prompt: "Hello",
        harness: "codex",
        directory: ".",
        signal,
    };
    if (olderChunks > 0) {
        const ownerApi = createOwnerApi({
            origin: bindings.origin,
            computerId: owner.computerId,
            credential: owner.computerToken,
            request: (request) => fetch(request),
            encryptionAccess: await runtime.encryptionAccess(signal),
        });
        try {
            const access = await ownerApi.api.createConversation(
                input.conversationKey,
                { harness: input.harness, workspaceRef: ".", workspaceLabel: ".", configurations: [] },
                signal,
            );
            const client = await ownerApi.api.connectSession(access.target, signal, access);
            const seeded = Promise.withResolvers<void>();
            const subscription = await client.events.subscribeLive(
                access.target,
                {
                    reconcile: async () => undefined,
                    receive: async (events) => {
                        if (
                            events.some(
                                (event) =>
                                    event.type === "lifecycle-metadata" &&
                                    event.payload.kind === "prompt.completed" &&
                                    event.payload.commandId === "earlier-turn",
                            )
                        ) {
                            seeded.resolve();
                        }
                        return true;
                    },
                },
                signal,
            );
            void subscription.completed.catch(() => undefined);
            try {
                await client.turns.submit(
                    access.target,
                    { content: "Earlier turn", attachments: [], idempotencyKey: "earlier-turn" },
                    signal,
                );
                await Promise.race([seeded.promise, subscription.completed]);
                signal.throwIfAborted();
            } finally {
                subscription.close();
            }
        } finally {
            ownerApi.close();
        }
    }
    const result = await helper.runSharedComputer(input);
    expect(result.answer).toBe("remote answer");
    expect((await helper.runSharedComputer(input)).answer).toBe("remote answer");
    link.searchParams.set("harness", "codex");
    link.searchParams.set("sessionId", nativeId);
    expect((await helper.runSharedComputer({ ...input, link: link.href, turnId: "native-turn" })).answer).toBe(
        "remote answer",
    );
    const cancellation = new AbortController();
    const pending = helper.runSharedComputer({
        ...input,
        link: link.href,
        turnId: "held-turn",
        prompt: "Wait",
        signal: AbortSignal.any([signal, cancellation.signal]),
    });
    const rejected = expect(pending).rejects.toBeDefined();
    await Promise.race([held.promise, pending]);
    cancellation.abort();
    await rejected;
});

test("Given a shared Computer and a missing directory, When the remote Agent creates a conversation, Then its error names the missing directory and explains how to recover", {
    timeout: 60_000,
}, async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-13T00:00:00Z") });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const createBindings = await prepareTestMortyRelayBindings();
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(45_000);
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
        behavior: {
            harness: "codex",
            agentName: "Controlled Codex",
            reply: () => ({ outcome: "complete", output: [{ kind: "text", text: "remote answer" }] }),
        },
        credential: owner.computerToken,
        computerId: owner.computerId,
        origin: bindings.origin,
        server: { request: async (input) => await fetch(input) },
        signal,
    });
    const share = await fetch(
        new URL(`/morty/api/v1/computers/${owner.computerId}/identity/transfers`, bindings.origin),
        {
            method: "POST",
            headers: { authorization: `Bearer ${owner.computerToken}`, "content-type": "application/json" },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
            signal,
        },
    );
    const link = new URL(v.parse(v.object({ url: v.string() }), await share.json()).url);
    const fragment = new URLSearchParams(link.hash.slice(1));
    fragment.set(
        "e2e",
        Buffer.from(computerEncryptionAccessCodec.encode(await runtime.encryptionAccess(signal))).toString("base64url"),
    );
    link.hash = fragment.toString();
    const document = await fetch(new URL("/doc/agent-api.md", bindings.origin), { signal });
    const bundle = /```js morty-remote-agent\n([\s\S]*?)\n```/u.exec(await document.text())?.[1];
    if (bundle === undefined) {
        throw new Error("Missing served helper");
    }
    const module: unknown = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
    const helper = v.parse(
        v.object({ runSharedComputer: v.custom<typeof runSharedComputer>((value) => typeof value === "function") }),
        module,
    );
    const directory = join(tmpdir(), `missing-remote-agent-${crypto.randomUUID()}`);
    await expect(
        helper.runSharedComputer({
            link: link.href,
            redemptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            conversationKey: "missing-directory-conversation",
            turnId: "missing-directory-turn",
            prompt: "Hello",
            harness: "codex",
            directory,
            signal,
        }),
    ).rejects.toMatchObject({
        code: "local_authorization_failed",
        message: `The directory ${JSON.stringify(directory)} does not exist. Choose an existing directory or create it locally before retrying.`,
    });
});
