import { base64urlnopad } from "@scure/base";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
} from "../../src/encryption.ts";
import {
    decodeClientToRelayMessage,
    decodeDaemonToRelayMessage,
    decodeNativeSessionRequest,
    decodeNativeSessionResult,
    type NativeSessionCommandRouting,
    type NativeSessionResultRouting,
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
} from "../../src/protocol/index.ts";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

async function endpoints() {
    const signal = new AbortController().signal;
    const identity = await generateE2EIdentity();
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    };
    const claimed = new Set<string>();
    const client = await createClientPayloadEncryption(access, signal);
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim) => {
            if (claimed.has(claim.fingerprint)) {
                throw new Error("Duplicate claim");
            }
            claimed.add(claim.fingerprint);
        },
        signal,
    );
    onTestFinished(() => {
        client.close();
        computer.close();
    });
    return { client, computer, signal };
}

const target = { harness: "codex", sessionId: "session-1" };
const requestBase = { kind: "native.session.request", requestId: "request-1" };
const requests = [
    { message: { ...requestBase, action: "active-turn", target }, routing: { action: "active-turn", target } },
    {
        message: { ...requestBase, action: "list", harness: "codex", directory: "/private/workspace", cursor: null },
        routing: { action: "list", harness: "codex" },
    },
    ...["find", "import", "fork"].map((action) => ({
        message: { ...requestBase, action, harness: "codex", sessionId: "session-1", directory: "/private/workspace" },
        routing: { action, target },
    })),
];

describe("Native Session routing", () => {
    it("Given a native action, when a relay narrows its route, then its authorization fields are required", () => {
        expectTypeOf<Extract<NativeSessionCommandRouting, { action: "import" }>>().toEqualTypeOf<{
            kind: "native.session.request";
            requestId: string;
            action: "import";
            target: Readonly<{ harness: string; sessionId: string }>;
            encrypted: string;
        }>();
        expectTypeOf<Extract<NativeSessionCommandRouting, { action: "list" }>>().toEqualTypeOf<{
            kind: "native.session.request";
            requestId: string;
            action: "list";
            harness: string;
            encrypted: string;
        }>();
        expectTypeOf<Extract<NativeSessionResultRouting, { action: "fork" }>>().toEqualTypeOf<{
            kind: "native.session.result";
            requestId: string;
            action: "fork";
            target: Readonly<{ harness: string; sessionId: string }>;
            encrypted: string;
        }>();
    });
    it.each(requests)(
        "Given a $message.action request, when it crosses the relay, then only its authorization route is visible",
        async ({ message, routing }) => {
            const { client, computer, signal } = await endpoints();
            const expected = decodeNativeSessionRequest(JSON.stringify(message));
            const wire = await nativeSessionCommandCodec.encode(expected, client, signal);
            const route = decodeClientToRelayMessage(wire);
            expect(route).toEqual({
                kind: requestBase.kind,
                requestId: requestBase.requestId,
                ...routing,
                encrypted: expect.any(String),
            });
            expect(wire).not.toContain("/private/workspace");
            expect(await nativeSessionCommandCodec.decode(wire, computer, signal)).toEqual(expected);
        },
    );

    it("Given a routed native request, when its authenticated action or target is changed, then the Computer rejects it", async () => {
        const { client, computer, signal } = await endpoints();
        const wire = await nativeSessionCommandCodec.encode(requests[2]?.message, client, signal);
        const route = nativeSessionCommandCodec.decodeRouting(wire);
        if (route.action !== "find") {
            throw new Error("Expected find route");
        }
        await expect(
            nativeSessionCommandCodec.decode(
                JSON.stringify({ ...route, target: { ...route.target, sessionId: "other" } }),
                computer,
                signal,
            ),
        ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
    });

    it("Given a routed import, when its action is changed to fork, then the Computer rejects it", async () => {
        const { client, computer, signal } = await endpoints();
        const wire = await nativeSessionCommandCodec.encode(
            {
                ...requestBase,
                action: "import",
                harness: "codex",
                sessionId: "session-1",
                directory: "/private/workspace",
            },
            client,
            signal,
        );
        const route = nativeSessionCommandCodec.decodeRouting(wire);
        if (route.action !== "import") {
            throw new Error("Expected import route");
        }
        await expect(
            nativeSessionCommandCodec.decode(JSON.stringify({ ...route, action: "fork" }), computer, signal),
        ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
    });

    it("Given an authenticated native request with conflicting private identity, when the Computer decrypts it, then it rejects the mismatch", async () => {
        const { client, computer, signal } = await endpoints();
        const routing = { kind: "native.session.request", requestId: "request-1", action: "import", target };
        const plaintext = { harness: "codex", sessionId: "other", directory: "/private/workspace" };
        const encoder = new TextEncoder();
        const encrypted = await client.encrypt(
            encoder.encode(JSON.stringify(plaintext)),
            encoder.encode(JSON.stringify(routing)),
            signal,
        );
        await expect(
            nativeSessionCommandCodec.decode(JSON.stringify({ ...routing, encrypted }), computer, signal),
        ).rejects.toMatchObject({ code: "invalid_protocol_message" });
    });
});

const capabilities = {
    audioPrompt: false,
    closeSession: false,
    deleteSession: false,
    embeddedContextPrompt: false,
    imagePrompt: false,
    listSessions: false,
    loadSession: false,
    promptQueueing: false,
    renameSession: false,
    resumeSession: false,
    steering: false,
    unstableForkSession: false,
};
const ready = {
    kind: "session.ready",
    requestId: "request-1",
    target,
    harness: "codex",
    agentName: "agent",
    agentVersion: "1",
    capabilities,
    commands: [],
    configOptions: [],
    configurationRevision: "rev-1",
    directory: "/private/workspace",
    directoryLabel: "workspace",
    restored: false,
};
const entry = {
    sessionId: "session-1",
    title: "private title",
    directory: "/private/workspace",
    directoryLabel: "workspace",
    updatedAt: null,
};
const resultBase = { kind: "native.session.result", requestId: "request-1" };
const results = [
    {
        message: {
            ...resultBase,
            action: "active-turn",
            target,
            queued: [],
            queuedCancellation: "before-start",
            interactionState: null,
            turn: null,
            executionPosition: { sessionGenerationId: "generation-1", throughPosition: "0" },
        },
        routing: { action: "active-turn", target },
    },
    { message: { ...resultBase, action: "find", entry }, routing: { action: "find" } },
    {
        message: { ...resultBase, action: "list", capabilities, entries: [entry], nextCursor: null },
        routing: { action: "list" },
    },
    ...["import", "fork"].map((action) => ({
        message: { ...resultBase, action, target, ready, title: "private title" },
        routing: { action, target },
    })),
];

it.each(results)(
    "Given a $message.action result, when it crosses the relay, then only its authorization route is visible",
    async ({ message, routing }) => {
        const { client, computer, signal } = await endpoints();
        const expected = decodeNativeSessionResult(JSON.stringify(message));
        const wire = await nativeSessionResultCodec.encode(expected, computer, signal);
        expect(decodeDaemonToRelayMessage(wire)).toEqual({
            kind: resultBase.kind,
            requestId: resultBase.requestId,
            ...routing,
            encrypted: expect.any(String),
        });
        expect(wire).not.toContain("private title");
        expect(wire).not.toContain("/private/workspace");
        expect(await nativeSessionResultCodec.decode(wire, client, signal)).toEqual(expected);
    },
);

it("Given a fork result, when its public target is changed, then the client rejects the ciphertext", async () => {
    const { client, computer, signal } = await endpoints();
    const wire = await nativeSessionResultCodec.encode(
        { ...resultBase, action: "fork", target, ready, title: "private title" },
        computer,
        signal,
    );
    const routing = nativeSessionResultCodec.decodeRouting(wire);
    if (routing.action !== "fork") {
        throw new Error("Expected fork route");
    }
    await expect(
        nativeSessionResultCodec.decode(
            JSON.stringify({ ...routing, target: { ...routing.target, sessionId: "other" } }),
            client,
            signal,
        ),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});
