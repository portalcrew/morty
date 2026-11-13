import { createServer, request } from "node:http";
import { WsTransport } from "@morty-build/client";
import {
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
    sessionOperationFailedEventCodec,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { startTestRelay } from "../support/relay.ts";
import { createFakeAgentHarnessRuntime } from "../support/relay-agent-harness.ts";
import { createForkLossProxy } from "./fixtures/fork-loss-proxy.ts";

afterEach(() => vi.useRealTimers());

test.each(["request", "result"] as const)(
    "Given the Computer Fork %s is lost, When the operation is retried after reconnect, Then one Fork exists and a completed Fork remains recoverable without its source",
    async (loss) => {
        vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date"] });
        await using relay = await startTestRelay();
        const signal = new AbortController().signal;
        const owner = await relay.createOwner();
        await using proxy = await createForkLossProxy(relay.baseUrl, loss);
        const disconnected = Promise.withResolvers<void>();
        const connected = Promise.withResolvers<void>();
        const reconnected = Promise.withResolvers<void>();
        let wasDisconnected = false;
        await using runtime = await createFakeAgentHarnessRuntime({
            credential: owner.token,
            origin: relay.baseUrl,
            relayOrigin: proxy.origin,
            computerId: owner.computerId,
            server: relay.app,
            signal,
            sessionIds: new Set(["native-fork-source"]),
            runtimeOptions: {
                onConnectionStatus: (status) => {
                    if (status === "reconnecting") {
                        wasDisconnected = true;
                        disconnected.resolve();
                    } else {
                        connected.resolve();
                        if (wasDisconnected) {
                            reconnected.resolve();
                        }
                    }
                },
            },
        });
        await connected.promise;
        await runtime.api.nativeSessions(
            {
                action: "list",
                harness: "claude",
                directory: ".",
                cursor: null,
            },
            signal,
        );
        vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
        const operationId = crypto.randomUUID();
        const input = {
            harness: "claude",
            directory: ".",
            sessionId: "native-fork-source",
        };
        const fork = () => runtime.api.forkNativeSession(operationId, input, signal);
        await expect(fork()).rejects.toMatchObject({ code: "computer_offline" });
        const lost = await proxy.lost;
        await disconnected.promise;
        await vi.advanceTimersByTimeAsync(500);
        await reconnected.promise;
        if (loss === "result") {
            await runtime.removeNativeSession("native-fork-source");
        }
        // The Computer answers a retry from the receipt it keeps under the operation, or forks once if the Fork never
        // reached it.
        const [first, concurrent] = await Promise.all([fork(), fork()]);
        expect(concurrent).toEqual(first);
        if (loss === "result") {
            expect(first.target).toEqual(lost);
        }
        expect(first.ready).toMatchObject({ restored: true });
        expect(await fork()).toEqual(first);
        const sessions = await runtime.api.managedSessions(signal);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.target).toEqual(first.target);
    },
);

test("Given a Fork succeeds but its response is lost, When the same operation is retried, Then its original Session is returned", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z"), toFake: ["Date"] });
    await using relay = await startTestRelay();
    const signal = new AbortController().signal;
    const owner = await relay.createOwner();
    const runtime = await relay.connectAgent(
        owner.computerId,
        undefined,
        new Set(["recovery-native-source", "another-native-source"]),
    );
    const transport = new WsTransport();
    onTestFinished(() => transport.close());
    transport.configureEncryption(await runtime.encryptionAccess(signal));
    const operationId = crypto.randomUUID();
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${owner.computerId}\u0000fork\u0000${operationId}`),
    );
    const requestId = `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const command = {
        kind: "native.session.request" as const,
        action: "fork" as const,
        requestId,
        harness: "claude",
        directory: ".",
        sessionId: "recovery-native-source",
    };
    let loseNextResponse = true;
    let lostStatus: number | undefined;
    const proxy = createServer((incoming, outgoing) => {
        const requested = new URL(incoming.url ?? "/", relay.baseUrl);
        const forwarded = request(
            new URL(relay.baseUrl),
            {
                path: requested.pathname + requested.search,
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(relay.baseUrl).host },
            },
            (response) => {
                if (loseNextResponse) {
                    loseNextResponse = false;
                    lostStatus = response.statusCode;
                    response.resume();
                    response.on("end", () => outgoing.destroy());
                } else {
                    outgoing.writeHead(response.statusCode ?? 502, response.headers);
                    response.pipe(outgoing);
                }
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.pipe(forwarded);
    });
    await listen(proxy);
    try {
        const url = `http://127.0.0.1:${port(proxy)}/morty/api/v1/computers/${owner.computerId}/native-sessions/forks/${operationId}`;
        const send = async (input = command) =>
            fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                body: await nativeSessionCommandCodec.encode(input, transport.payloadEncryption, signal),
                signal,
            });
        const initial = await Promise.allSettled([send(), send()]);
        expect(initial.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
        const delivered = initial.find((attempt) => attempt.status === "fulfilled");
        if (delivered?.status !== "fulfilled") {
            throw new Error("The concurrent Fork response did not arrive");
        }
        expect(delivered.value.status).toBe(200);
        expect(lostStatus).toBe(200);
        const retried = await send();
        expect(retried.status).toBe(200);
        const result = await nativeSessionResultCodec.decode(await retried.text(), transport.payloadEncryption, signal);
        const [concurrent, conflicting] = await Promise.all([
            Promise.all([send(), send()]),
            send({ ...command, sessionId: "another-native-source" }),
        ]);
        for (const replay of concurrent) {
            expect(replay.status).toBe(200);
            expect(
                await nativeSessionResultCodec.decode(await replay.text(), transport.payloadEncryption, signal),
            ).toEqual(result);
        }
        expect(conflicting.status).toBe(200);
        expect(
            await sessionOperationFailedEventCodec.decode(
                await conflicting.text(),
                transport.payloadEncryption,
                signal,
            ),
        ).toMatchObject({ code: "idempotency_conflict", requestId });
        const conflict = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
            body: await nativeSessionCommandCodec.encode(
                { ...command, sessionId: "another-native-source" },
                transport.payloadEncryption,
                signal,
            ),
            signal,
        });
        expect(conflict.status).toBe(200);
        expect(
            await sessionOperationFailedEventCodec.decode(await conflict.text(), transport.payloadEncryption, signal),
        ).toMatchObject({ code: "idempotency_conflict", requestId });
        const after = await runtime.api.managedSessions(signal);
        expect(after).toHaveLength(1); // One tracked fork for the user's one intent; the native source was never imported.
    } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
});
