import { computerEncryptionAccessCodec } from "@morty-build/client";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { expect, onTestFinished, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../tests/support/fake-daemon/runtime.ts";
import type { runSharedComputer } from "../../web/src/services/remote-agent.ts";

test("Given a shared Computer, when a remote Agent runs the served helper, then it receives the Agent's answer", {
    timeout: 90_000,
}, async () => {
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
