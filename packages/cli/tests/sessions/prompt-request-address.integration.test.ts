import { MortyClient, MortyPageRequest, sessionEndpoints, WsTransport } from "@portalcrew/morty-client";
import {
    decodeMessageKind,
    decodeSessionReadyEvent,
    sessionOperationFailedEventCodec,
    sessionPromptAcceptedEventCodec,
    sessionPromptCommandCodec,
} from "@portalcrew/morty-client/protocol";
import { prepareTestMortyRelayBindings } from "@portalcrew/morty-relay-test-support/cloudflare";
import * as v from "valibot";
import { expect, test, vi } from "vitest";
import { createControlledAgentRuntime } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createOwnerApi } from "../../../../tests/support/owner-api.ts";

test("Given a prompt with a separate reply address, when it is retried or conflicts, then the Computer answers each request without running a second Turn", {
    timeout: 60_000,
}, async ({ signal }) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    try {
        const createBindings = await prepareTestMortyRelayBindings();
        await using bindings = await createBindings();
        await bindings.configure({ APP_ORIGIN: bindings.origin });
        const created = await fetch(new URL("/morty/api/v1/computers", bindings.origin), {
            method: "POST",
            signal,
        });
        expect(created.status).toBe(201);
        const owner = v.parse(v.object({ computerId: v.string(), computerToken: v.string() }), await created.json());
        await using runtime = await createControlledAgentRuntime({
            behavior: {
                harness: "codex",
                agentName: "Controlled Codex",
                reply: () => ({ outcome: "complete", output: [{ kind: "text", text: "completed once" }] }),
            },
            credential: owner.computerToken,
            computerId: owner.computerId,
            origin: bindings.origin,
            server: { request: async (request) => await fetch(request) },
            signal,
        });
        const encryptionAccess = await runtime.encryptionAccess(signal);
        const ownerClient = createOwnerApi({
            origin: bindings.origin,
            computerId: owner.computerId,
            credential: owner.computerToken,
            encryptionAccess,
        });
        const transport = new WsTransport();
        try {
            await ownerClient.api.verifyAgent("codex", signal);
            const access = await ownerClient.api.createConversation(
                "request-address",
                { harness: "codex", configurations: [], workspaceRef: ".", workspaceLabel: "." },
                signal,
            );
            const target = decodeSessionReadyEvent(JSON.stringify(access.ready)).target;
            const client = new MortyClient({
                endpoint: bindings.origin,
                computerId: owner.computerId,
                transport,
                credentialProvider: { credential: async () => access.credential },
                encryption: { access: encryptionAccess },
            });
            try {
                const completed = Promise.withResolvers<void>();
                const live = await client.events.subscribeLive(
                    target,
                    {
                        reconcile: async () => undefined,
                        receive: async (events) => {
                            if (
                                events.some(
                                    (event) =>
                                        event.type === "lifecycle-metadata" &&
                                        event.payload.kind === "prompt.completed" &&
                                        event.payload.commandId === "turn-one",
                                )
                            ) {
                                completed.resolve();
                            }
                            return true;
                        },
                    },
                    signal,
                );
                try {
                    const submit = async (requestId: string, prompt: string) => {
                        const body = await sessionPromptCommandCodec.encode(
                            {
                                kind: "session.prompt",
                                requestId,
                                commandId: "turn-one",
                                target,
                                disposition: "append",
                                attachments: [],
                                prompt,
                            },
                            transport.payloadEncryption,
                            signal,
                        );
                        const response = await transport.fetch({
                            origin: new URL("/morty/api/", bindings.origin),
                            endpoint: sessionEndpoints.submitTurn({ computerId: owner.computerId, target }),
                            headers: {
                                authorization: `Bearer ${access.credential}`,
                                "content-type": "application/json",
                            },
                            body,
                            requestId: crypto.randomUUID(),
                            signal,
                        });
                        expect(response.ok).toBe(true);
                        const wire = await response.text();
                        return decodeMessageKind(wire) === "session.prompt.accepted"
                            ? await sessionPromptAcceptedEventCodec.decode(wire, transport.payloadEncryption, signal)
                            : await sessionOperationFailedEventCodec.decode(wire, transport.payloadEncryption, signal);
                    };
                    expect(await submit("request-first", "same prompt")).toMatchObject({
                        kind: "session.prompt.accepted",
                        requestId: "request-first",
                    });
                    await Promise.race([completed.promise, live.completed, runtime.failure]);
                    expect(await submit("request-retry", "same prompt")).toMatchObject({
                        kind: "session.prompt.accepted",
                        requestId: "request-retry",
                        standing: { state: "settled" },
                    });
                    expect(await submit("request-conflict", "different prompt")).toMatchObject({
                        kind: "session.operation.failed",
                        requestId: "request-conflict",
                        code: "command_identity_conflict",
                    });
                    const page = await client.events.list(target, new MortyPageRequest(100, ""), signal);
                    expect(JSON.stringify(page).match(/prompt\.started/g)).toHaveLength(1);
                } finally {
                    live.close();
                }
            } finally {
                client.close();
            }
        } finally {
            ownerClient.close();
            transport.close();
        }
    } finally {
        vi.useRealTimers();
    }
});
