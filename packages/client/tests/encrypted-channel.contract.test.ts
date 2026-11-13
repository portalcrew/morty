import { once } from "node:events";
import { createServer } from "node:http";
import { base64urlnopad } from "@scure/base";
import { afterEach, beforeEach, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { sessionEndpoints } from "../src/calls/session.ts";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    E2EError,
    exportE2EPublicKey,
    generateE2EIdentity,
    type PayloadEncryptionConnection,
} from "../src/encryption.ts";
import {
    type ClientCommand,
    type DaemonMessage,
    type DaemonToRelayMessage,
    decodeDaemonToRelayMessage,
    decodeRelayToDaemonMessage,
    type RelayToDaemonMessage,
    type SessionPromptCommand,
} from "../src/protocol/index.ts";
import { agentSettingsDiscoveredEventCodec } from "../src/protocol/session/agent/settings.ts";
import { sessionConfigReadCommandCodec } from "../src/protocol/session/configuration/index.ts";
import { sessionRenamedEventCodec } from "../src/protocol/session/configuration/title.ts";
import type { SessionEventEnvelope } from "../src/protocol/session/events/index.ts";
import { sessionEventEnvelopeCodec } from "../src/protocol/session/events/index.ts";
import {
    sessionOperationFailedEventCodec,
    sessionPromptAcceptedEventCodec,
} from "../src/protocol/session/lifecycle/index.ts";
import { sessionPromptCommandCodec } from "../src/protocol/session/prompt/commands.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

// A real socket hop records only what an untrusted transport can observe. Both endpoints use the Computer capability.
async function opaqueHop() {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const frames: string[] = [];
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a listening TCP socket");
    }
    onTestFinished(async () => {
        for (const socket of sockets.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const connected = once(sockets, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const [daemon] = await connected;
    if (!(daemon instanceof WebSocket)) {
        throw new Error("Expected a WebSocket peer");
    }
    await once(client, "open");
    return {
        frames,
        transfer: async (wire: string, direction: "client" | "daemon" = "client") => {
            const sender = direction === "client" ? client : daemon;
            const receiver = direction === "client" ? daemon : client;
            const received = once(receiver, "message");
            sender.send(wire);
            const [data] = await received;
            const frame = String(data);
            frames.push(frame);
            return frame;
        },
    };
}

async function endpoints() {
    const identity = await generateE2EIdentity();
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(12)),
    };
    const claims = new Set<string>();
    const signal = new AbortController().signal;
    const openComputer = () =>
        createComputerPayloadEncryption(
            access,
            async (claim, claimSignal) => {
                claimSignal.throwIfAborted();
                if (claims.has(claim.fingerprint)) {
                    throw new E2EError("e2e_invalid_frame");
                }
                claims.add(claim.fingerprint);
            },
            signal,
        );
    return {
        client: await createClientPayloadEncryption(access, signal),
        computer: await openComputer(),
        access,
        openComputer,
    };
}

it("Given a full replay window, when authenticated traffic and tampered traffic arrive, then only authenticated capacity exhaustion reports store busy", {
    timeout: 120_000,
}, async () => {
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const body = new Uint8Array([1]);
    const associatedData = new TextEncoder().encode("capacity-check");
    let first: string | null = null;
    try {
        for (let index = 0; index < 65_536; index += 1) {
            const encoded = await client.encrypt(body, associatedData, signal);
            if (first === null) {
                first = encoded;
            }
            await computer.decrypt(encoded, associatedData, signal);
        }
        if (first === null) {
            throw new Error("Expected an authenticated packet");
        }
        await expect(computer.decrypt(await hop.transfer(first), associatedData, signal)).rejects.toMatchObject({
            code: "e2e_invalid_frame",
        });
        const fresh = await client.encrypt(body, associatedData, signal);
        const bytes = base64urlnopad.decode(fresh);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        await expect(
            computer.decrypt(await hop.transfer(base64urlnopad.encode(bytes)), associatedData, signal),
        ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
        await expect(computer.decrypt(await hop.transfer(fresh), associatedData, signal)).rejects.toMatchObject({
            code: "e2e_store_busy",
        });
        vi.setSystemTime(new Date("2026-11-12T00:05:00Z"));
        const afterExpiry = await client.encrypt(body, associatedData, signal);
        expect(await computer.decrypt(await hop.transfer(afterExpiry), associatedData, signal)).toEqual(body);
    } finally {
        client.close();
        computer.close();
    }
});

it("Given a file read and a history request, when a client addresses them, then neither the file path nor the history cursor appears in the request address", () => {
    const target = { harness: "codex", sessionId: "session-1" };
    const file = sessionEndpoints.readFile({ computerId: "computer-1", target });
    const history = sessionEndpoints.listEvents({
        computerId: "computer-1",
        target,
        limit: 25,
        cursor: "private-cursor",
    });
    expect(file.method).toBe("POST");
    expect(file.transport).toEqual({ kind: "http" });
    expect(new URL(file.path, "https://example.invalid").search).toBe("");
    expect(history.path).not.toContain("cursor");
    expect(history.path).not.toContain("private");
});

function frameRecord(encoded: string): Readonly<Record<string, unknown>> {
    const value: unknown = JSON.parse(encoded);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected an envelope");
    }
    return Object.fromEntries(Object.entries(value));
}

// Adversarial wire construction deliberately bypasses endpoint schemas, but uses the real cryptographic primitive.
async function forgePacket(
    context: PayloadEncryptionConnection,
    value: Readonly<Record<string, unknown>> & { readonly kind: string },
    signal: AbortSignal,
    routing: Readonly<Record<string, unknown>> = {},
) {
    const fields = Object.entries(value);
    const metadata = {
        ...routing,
        ...Object.fromEntries(
            fields.filter(([field]) => field === "requestId" || field === "commandId" || field === "target"),
        ),
    };
    const body = Object.fromEntries(
        fields.filter(
            ([field]) => field !== "kind" && field !== "requestId" && field !== "commandId" && field !== "target",
        ),
    );
    const ciphertext = await context.encrypt(
        new TextEncoder().encode(JSON.stringify(body)),
        new TextEncoder().encode(JSON.stringify([value.kind, metadata])),
        signal,
    );
    return JSON.stringify({ kind: value.kind, ...metadata, encrypted: ciphertext });
}

async function decryptPacket(
    context: PayloadEncryptionConnection,
    encoded: string,
    signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>> & { readonly kind: string }> {
    const frame = frameRecord(encoded);
    if (typeof frame["kind"] !== "string" || typeof frame["encrypted"] !== "string") {
        throw new Error("Expected a wire packet");
    }
    const { kind, encrypted, ...metadata } = frame;
    const bytes = await context.decrypt(encrypted, new TextEncoder().encode(JSON.stringify([kind, metadata])), signal);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("Expected a message payload");
    }
    return { ...Object.fromEntries(Object.entries(body)), ...metadata, kind: frame["kind"] };
}

it("Given a Computer capability, when a prompt and reply cross an untrusted hop, then only its holders see their content", async () => {
    expectTypeOf<Extract<DaemonToRelayMessage, { kind: "session.event.v2" }>>().toEqualTypeOf<{
        kind: "session.event.v2";
        target: Readonly<{ harness: string; sessionId: string }>;
        encrypted: string;
    }>();
    expectTypeOf<Extract<DaemonMessage, { kind: "session.event.v2" }>>().toEqualTypeOf<SessionEventEnvelope>();
    expectTypeOf<"events">().not.toExtend<keyof Extract<DaemonToRelayMessage, { kind: "session.event.v2" }>>();
    expectTypeOf<"encrypted">().not.toExtend<keyof Extract<DaemonMessage, { kind: "session.event.v2" }>>();
    expectTypeOf<Extract<RelayToDaemonMessage, { kind: "session.prompt" }>>().toEqualTypeOf<{
        kind: "session.prompt";
        requestId: string;
        target: Readonly<{ harness: string; sessionId: string }>;
        commandId: string;
        encrypted: string;
    }>();
    expectTypeOf<Extract<ClientCommand, { kind: "session.prompt" }>>().toEqualTypeOf<SessionPromptCommand>();
    expectTypeOf<"prompt">().not.toExtend<keyof Extract<RelayToDaemonMessage, { kind: "session.prompt" }>>();
    expectTypeOf<"attachments">().toExtend<keyof Extract<ClientCommand, { kind: "session.prompt" }>>();
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const request: SessionPromptCommand = {
        kind: "session.prompt",
        requestId: "private-request",
        commandId: "private-request",
        target: { harness: "codex", sessionId: "private-session" },
        prompt: "private prompt",
        attachments: [],
        disposition: "append",
    };
    const turnCall = sessionEndpoints.submitTurn({ computerId: "computer-1", target: request.target });
    const eventCall = sessionEndpoints.liveEvents({ computerId: "computer-1", target: request.target });
    expect(turnCall.encrypted.request).toContain(sessionPromptCommandCodec);
    expect(eventCall.encrypted.response).toContain(sessionEventEnvelopeCodec);
    const wire = await sessionPromptCommandCodec.encode(request, client, signal);
    const promptFrame = await hop.transfer(wire);
    expect(decodeRelayToDaemonMessage(promptFrame)).toEqual({
        kind: request.kind,
        requestId: request.requestId,
        commandId: request.commandId,
        target: request.target,
        encrypted: frameRecord(promptFrame)["encrypted"],
    });
    expect(await sessionPromptCommandCodec.decode(promptFrame, computer, signal)).toEqual(request);
    const accepted = {
        kind: "session.prompt.accepted",
        requestId: request.requestId,
        target: request.target,
        state: "running",
    };
    expect(
        await sessionPromptAcceptedEventCodec.decode(
            await hop.transfer(await sessionPromptAcceptedEventCodec.encode(accepted, computer, signal), "daemon"),
            client,
            signal,
        ),
    ).toEqual(accepted);
    const reply: SessionEventEnvelope = {
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                sessionGenerationId: "generation-1",
                target: request.target,
                recordedAt: "2026-11-12T00:00:00Z",
                position: "1",
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "message-1",
                    content: { type: "text", text: "private answer" },
                },
            },
        ],
    };
    expect(
        await sessionEventEnvelopeCodec.decode(
            await hop.transfer(await sessionEventEnvelopeCodec.encode(reply, computer, signal), "daemon"),
            client,
            signal,
        ),
    ).toEqual(reply);
    expect(Object.keys(frameRecord(hop.frames[0] ?? "")).sort()).toEqual([
        "commandId",
        "encrypted",
        "kind",
        "requestId",
        "target",
    ]);
    expect(Object.keys(frameRecord(hop.frames[1] ?? "")).sort()).toEqual(["encrypted", "kind", "requestId", "target"]);
    expectTypeOf<ReturnType<typeof sessionEventEnvelopeCodec.decodeRouting>>().toEqualTypeOf<{
        kind: "session.event.v2";
        target: Readonly<{ harness: string; sessionId: string }>;
        encrypted: string;
    }>();
    const eventFrame = hop.frames[2] ?? "";
    expect(Object.keys(frameRecord(eventFrame)).sort()).toEqual(["encrypted", "kind", "target"]);
    expect(sessionEventEnvelopeCodec.decodeRouting(eventFrame)).toEqual({
        kind: "session.event.v2",
        target: request.target,
        encrypted: frameRecord(eventFrame)["encrypted"],
    });
    expect(decodeDaemonToRelayMessage(eventFrame)).toEqual(sessionEventEnvelopeCodec.decodeRouting(eventFrame));
    for (const frame of hop.frames) {
        expect(frameRecord(frame)).not.toHaveProperty("header");
        expect(frameRecord(frame)).not.toHaveProperty("payload");
        expect(frameRecord(frame)).not.toHaveProperty("channelId");
        for (const secret of ["private prompt", "private answer"]) {
            expect(frame).not.toContain(secret);
        }
    }
});

it("Given an encrypted event batch, when its public target is altered across the hop, then authentication fails", async () => {
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const event: SessionEventEnvelope = {
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                sessionGenerationId: "generation-1",
                target: { harness: "codex", sessionId: "session-1" },
                recordedAt: "2026-11-12T00:00:00Z",
                position: "1",
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "message-1",
                    content: { type: "text", text: "private answer" },
                },
            },
        ],
    };
    const wire = await hop.transfer(await sessionEventEnvelopeCodec.encode(event, computer, signal), "daemon");
    const packet = frameRecord(wire);
    await expect(
        sessionEventEnvelopeCodec.decode(
            JSON.stringify({
                ...packet,
                target: { harness: "codex", sessionId: "session-2" },
            }),
            client,
            signal,
        ),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});

it("Given authenticated event ciphertext for another target, when the receiver decodes it, then the conflicting batch is rejected", async () => {
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = { kind: "session.event.v2", target: { harness: "codex", sessionId: "session-1" } };
    const events = [
        {
            eventId: "event-1",
            sessionGenerationId: "generation-1",
            target: { harness: "codex", sessionId: "session-2" },
            recordedAt: "2026-11-12T00:00:00Z",
            position: "1",
            type: "acp",
            payload: {
                sessionUpdate: "agent_message_chunk",
                messageId: "message-1",
                content: { type: "text", text: "private answer" },
            },
        },
    ];
    const encrypted = await computer.encrypt(
        new TextEncoder().encode(JSON.stringify({ events })),
        new TextEncoder().encode(JSON.stringify(routing)),
        signal,
    );
    const wire = await hop.transfer(JSON.stringify({ ...routing, encrypted }), "daemon");
    await expect(sessionEventEnvelopeCodec.decode(wire, client, signal)).rejects.toMatchObject({
        code: "invalid_protocol_message",
    });
});

it("Given events from different Sessions, when a publisher encodes one batch, then no frame is emitted", async () => {
    const { computer } = await endpoints();
    const signal = new AbortController().signal;
    const first = {
        eventId: "event-1",
        sessionGenerationId: "generation-1",
        target: { harness: "codex", sessionId: "session-1" },
        recordedAt: "2026-11-12T00:00:00Z",
        position: "1",
        type: "acp",
        payload: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "private answer" },
        },
    };
    const second = {
        ...first,
        eventId: "event-2",
        target: { harness: "codex", sessionId: "session-2" },
        position: "2",
    };
    await expect(async () =>
        sessionEventEnvelopeCodec.encode({ kind: "session.event.v2", events: [first, second] }, computer, signal),
    ).rejects.toMatchObject({ code: "invalid_protocol_message" });
});

it("Given an encrypted flat prompt, when its public address is altered, then full decoding rejects the tampered frame", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const codec = sessionPromptCommandCodec;
    const wire = await codec.encode(
        {
            kind: "session.prompt",
            requestId: "request-1",
            commandId: "command-1",
            target: { harness: "codex", sessionId: "session-1" },
            prompt: "private prompt",
            attachments: [],
            disposition: "append",
        },
        client,
        signal,
    );
    const packet = frameRecord(wire);
    await expect(
        codec.decode(JSON.stringify({ ...packet, commandId: "command-2" }), computer, signal),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});

it("Given a flat prompt, when its schema encrypts it across an untrusted hop, then routing sees only declared fields and the receiver recovers the original", async () => {
    expectTypeOf<ReturnType<typeof sessionPromptCommandCodec.decodeRouting>>().toEqualTypeOf<{
        kind: "session.prompt";
        requestId: string;
        target: Readonly<{ harness: string; sessionId: string }>;
        commandId: string;
        encrypted: string;
    }>();
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const message: SessionPromptCommand = {
        kind: "session.prompt",
        requestId: "request-1",
        target: { harness: "codex", sessionId: "session-1" },
        commandId: "command-1",
        prompt: "private prompt",
        attachments: [],
        disposition: "append",
    };
    const codec = sessionPromptCommandCodec;
    const wire = await hop.transfer(await codec.encode(message, client, signal));
    const packet = frameRecord(wire);
    expect(Object.keys(packet).sort()).toEqual(["commandId", "encrypted", "kind", "requestId", "target"]);
    expect(wire).not.toContain("private prompt");
    expect(codec.decodeRouting(wire)).toEqual(packet);
    const { commandId: _commandId, ...withoutCommandId } = packet;
    const { requestId: _requestId, ...withoutRequestId } = packet;
    const { target: _target, ...withoutTarget } = packet;
    for (const invalid of [
        withoutCommandId,
        withoutRequestId,
        withoutTarget,
        { ...packet, commandId: "" },
        { ...packet, target: { harness: "codex", sessionId: "" } },
        { ...packet, encrypted: "" },
        { ...packet, prompt: "plaintext" },
        { ...packet, requestId: "" },
        { ...packet, channelId: "unrelated" },
        { ...packet, kind: "session.cancel" },
    ]) {
        expect(() => codec.decodeRouting(JSON.stringify(invalid))).toThrow();
    }
    expect(await codec.decode(wire, computer, signal)).toEqual(message);
    await expect(codec.decode(wire, computer, signal)).rejects.toMatchObject({ code: "e2e_invalid_frame" });
});

it("Given Agent settings routing metadata, when a reply crosses the relay boundary, then its ciphertext is not interpreted", () => {
    expectTypeOf<ReturnType<typeof agentSettingsDiscoveredEventCodec.decodeRouting>>().toEqualTypeOf<{
        kind: "agent.settings.discovered";
        requestId: string;
        harness: string;
        encrypted: string;
    }>();
    const codec = agentSettingsDiscoveredEventCodec;
    for (const encrypted of ["opaque-ciphertext", JSON.stringify({ opaque: "application-owned" })]) {
        const packet = {
            kind: "agent.settings.discovered",
            requestId: "request-1",
            harness: "agent-1",
            encrypted,
        };
        expect(codec.decodeRouting(JSON.stringify(packet))).toEqual(packet);
        const { requestId: _requestId, ...withoutRequestId } = packet;
        const { harness: _harness, ...withoutHarness } = packet;
        for (const invalid of [
            withoutRequestId,
            withoutHarness,
            { ...packet, requestId: "" },
            { ...packet, harness: "" },
            { ...packet, commandId: "unrelated" },
            { ...packet, kind: "agent.settings.discovery.failed" },
        ]) {
            expect(() => codec.decodeRouting(JSON.stringify(invalid))).toThrow();
        }
    }
});

it("Given an authenticated sender, when a decrypted command violates its endpoint schema, then the computer rejects it before execution", async () => {
    const { client, computer } = await endpoints();
    const call = sessionEndpoints.submitTurn({
        computerId: "computer-1",
        target: { harness: "codex", sessionId: "session-1" },
    });
    const signal = new AbortController().signal;
    const malformedCommand = await forgePacket(
        client,
        { kind: "session.prompt", prompt: "missing identity and target" },
        signal,
    );
    expect(call.encrypted.request).toContain(sessionPromptCommandCodec);
    await expect(sessionPromptCommandCodec.decode(malformedCommand, computer, signal)).rejects.toMatchObject({
        code: "invalid_protocol_message",
    });
});

it("Given valid public routing and an authenticated malformed private body, when the schema decrypts it, then full validation rejects it", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = {
        kind: "session.prompt",
        requestId: "request-1",
        target: { harness: "codex", sessionId: "session-1" },
        commandId: "command-1",
    };
    const encrypted = await client.encrypt(
        new TextEncoder().encode(JSON.stringify({ prompt: 42, attachments: [], disposition: "append" })),
        new TextEncoder().encode(JSON.stringify(routing)),
        signal,
    );
    const codec = sessionPromptCommandCodec;
    const wire = JSON.stringify({ ...routing, encrypted });
    expect(codec.decodeRouting(wire)).toEqual({ ...routing, encrypted });
    await expect(codec.decode(wire, computer, signal)).rejects.toMatchObject({ code: "invalid_protocol_message" });
});

it("Given authenticated ciphertext containing a second routing field, when the receiver decrypts it, then it rejects the duplicate", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = {
        kind: "session.prompt",
        requestId: "request-1",
        target: { harness: "codex", sessionId: "session-1" },
        commandId: "command-1",
    };
    const encrypted = await client.encrypt(
        new TextEncoder().encode(
            JSON.stringify({
                commandId: "command-2",
                prompt: "private prompt",
                attachments: [],
                disposition: "append",
            }),
        ),
        new TextEncoder().encode(JSON.stringify(routing)),
        signal,
    );
    const wire = JSON.stringify({ ...routing, encrypted });
    expect(sessionPromptCommandCodec.decodeRouting(wire)).toEqual({ ...routing, encrypted });
    await expect(sessionPromptCommandCodec.decode(wire, computer, signal)).rejects.toMatchObject({
        code: "invalid_protocol_message",
    });
});

it("Given a command with no private fields, when it crosses an untrusted hop, then its routing and full message still round-trip", async () => {
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const message = {
        kind: "session.config.read",
        requestId: "request-1",
        target: { harness: "codex", sessionId: "session-1" },
    };
    const wire = await hop.transfer(await sessionConfigReadCommandCodec.encode(message, client, signal));
    const packet = frameRecord(wire);
    expect(Object.keys(packet).sort()).toEqual(["encrypted", "kind", "requestId", "target"]);
    expect(sessionConfigReadCommandCodec.decodeRouting(wire)).toEqual(packet);
    expect(await sessionConfigReadCommandCodec.decode(wire, computer, signal)).toEqual(message);
});

it("Given a call declaration, when a different operation is delivered to its decoder, then it cannot be interpreted as that call", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const call = sessionEndpoints.submitTurn({
        computerId: "computer-1",
        target: { harness: "codex", sessionId: "session-1" },
    });
    const wrongOperation = await forgePacket(
        client,
        {
            kind: "session.cancel",
            requestId: "request-1",
            commandId: "command-1",
            target: { harness: "codex", sessionId: "session-1" },
        },
        signal,
    );
    expect(call.encrypted.request).toContain(sessionPromptCommandCodec);
    await expect(sessionPromptCommandCodec.decode(wrongOperation, computer, signal)).rejects.toMatchObject({
        code: "invalid_protocol_message",
    });
});

it("Given a declared call, when the computer refuses its request, then its encrypted failure retains the machine-readable code", async () => {
    const hop = await opaqueHop();
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const call = sessionEndpoints.submitTurn({
        computerId: "computer-1",
        target: { harness: "codex", sessionId: "session-1" },
    });
    const failure = {
        kind: "session.operation.failed",
        requestId: "request-1",
        code: "computer_offline",
        message: "The local computer is offline",
    };
    expect(call.encrypted.response).toContain(sessionOperationFailedEventCodec);
    const wire = await sessionOperationFailedEventCodec.encode(failure, computer, signal);
    expect(await sessionOperationFailedEventCodec.decode(await hop.transfer(wire, "daemon"), client, signal)).toEqual(
        failure,
    );
    expect(wire).not.toContain("computer_offline");
});

it("Given a call's response codec, when a different operation's valid response arrives, then the endpoint schema rejects it", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const target = { harness: "codex", sessionId: "session-1" };
    const call = sessionEndpoints.submitTurn({ computerId: "computer-1", target });
    const renameCall = sessionEndpoints.rename({ computerId: "computer-1", target });
    expect(renameCall.encrypted.response).toContain(sessionRenamedEventCodec);
    const wrongResponse = await sessionRenamedEventCodec.encode(
        {
            kind: "session.renamed",
            requestId: "request-1",
            target,
            title: "a different operation",
            updatedAt: "2026-11-12T00:00:00Z",
        },
        computer,
        signal,
    );
    expect(call.encrypted.response).toContain(sessionPromptAcceptedEventCodec);
    await expect(sessionPromptAcceptedEventCodec.decode(wrongResponse, client, signal)).rejects.toMatchObject({
        code: "invalid_protocol_message",
    });
});

it("Given an encrypted Computer request, when a frame is replayed, then the Computer refuses it", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frame = await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal);
    await decryptPacket(computer, frame, signal);
    await expect(decryptPacket(computer, frame, signal)).rejects.toMatchObject({ code: "e2e_invalid_frame" });
});

it("Given an authenticated frame, when its visible kind is changed, then it cannot be decrypted", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frame: unknown = JSON.parse(await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal));
    if (typeof frame !== "object" || frame === null) {
        throw new Error("Expected a frame");
    }
    await expect(
        decryptPacket(computer, JSON.stringify({ ...frame, kind: "session.cancel" }), signal),
    ).rejects.toMatchObject({
        code: "e2e_authentication_failed",
    });
});

it("Given a Computer capability, when a client uses a different secret, then authentication fails", async () => {
    const { access, computer } = await endpoints();
    const signal = new AbortController().signal;
    const impostor = await createClientPayloadEncryption(
        { ...access, computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(13)) },
        signal,
    );
    await expect(
        decryptPacket(
            computer,
            await forgePacket(impostor, { kind: "session.prompt", prompt: "hello" }, signal),
            signal,
        ),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});

it("Given a request or response, when it is reflected to its own sender, then authentication fails", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = new TextEncoder().encode("routing");
    const payload = new TextEncoder().encode("private");
    const request = await client.encrypt(payload, routing, signal);
    const response = await computer.encrypt(payload, routing, signal);
    await expect(client.decrypt(request, routing, signal)).rejects.toMatchObject({ code: "e2e_authentication_failed" });
    await expect(computer.decrypt(response, routing, signal)).rejects.toMatchObject({
        code: "e2e_authentication_failed",
    });
});

it("Given a frame for one Computer, when it is delivered to another Computer, then authentication fails", async () => {
    const { client, access } = await endpoints();
    const signal = new AbortController().signal;
    const claims = new Set<string>();
    const otherComputer = await createComputerPayloadEncryption(
        { ...access, computerId: "computer-2" },
        async (claim) => {
            if (claims.has(claim.fingerprint)) {
                throw new E2EError("e2e_invalid_frame");
            }
            claims.add(claim.fingerprint);
        },
        signal,
    );
    await expect(
        decryptPacket(
            otherComputer,
            await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal),
            signal,
        ),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});

it("Given concurrent sends, when they are delivered in order, then every request retains its identity", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frames = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
            forgePacket(client, { kind: "session.prompt", requestId: String(index) }, signal),
        ),
    );
    const messages = await Promise.all(frames.map((frame) => decryptPacket(computer, frame, signal)));
    expect(messages.map((message) => message["requestId"])).toEqual(
        Array.from({ length: 8 }, (_, index) => String(index)),
    );
});

it("Given a ciphertext, when its bytes change, then no plaintext is released and the original remains usable", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frame = await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal);
    const envelope = frameRecord(frame);
    if (typeof envelope["encrypted"] !== "string") {
        throw new Error("Expected ciphertext");
    }
    const bytes = base64urlnopad.decode(envelope["encrypted"]);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(
        decryptPacket(computer, JSON.stringify({ ...envelope, encrypted: base64urlnopad.encode(bytes) }), signal),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
    expect(await decryptPacket(computer, frame, signal)).toMatchObject({ prompt: "hello" });
});

it("Given independent application frames, when a later frame arrives first, then both can be decrypted", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const first = await forgePacket(client, { kind: "session.prompt", requestId: "first" }, signal);
    const second = await forgePacket(client, { kind: "session.cancel", requestId: "second" }, signal);
    expect(await decryptPacket(computer, second, signal)).toMatchObject({ requestId: "second" });
    expect(await decryptPacket(computer, first, signal)).toMatchObject({ requestId: "first" });
});

it("Given encryption is selected, when a legacy plaintext message arrives, then it is rejected rather than downgraded", async () => {
    const { computer } = await endpoints();
    const call = sessionEndpoints.submitTurn({
        computerId: "computer-1",
        target: { harness: "codex", sessionId: "session-1" },
    });
    expect(call.encrypted.request).toContain(sessionPromptCommandCodec);
    await expect(
        sessionPromptCommandCodec.decode(
            JSON.stringify({ kind: "session.prompt", prompt: "plaintext" }),
            computer,
            new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "invalid_protocol_message" });
});

it("Given an encrypted message, when an undeclared field is added outside encryption, then it is rejected", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frame = frameRecord(
        await forgePacket(client, { kind: "session.prompt", requestId: "private-request" }, signal),
    );
    const call = sessionEndpoints.submitTurn({
        computerId: "computer-1",
        target: { harness: "codex", sessionId: "session-1" },
    });
    expect(call.encrypted.request).toContain(sessionPromptCommandCodec);
    await expect(
        sessionPromptCommandCodec.decode(JSON.stringify({ ...frame, prompt: "plaintext" }), computer, signal),
    ).rejects.toMatchObject({ code: "invalid_protocol_message" });
});

it("Given a cancelled operation, when encryption is requested, then the original cancellation is preserved", async () => {
    const { client } = await endpoints();
    const controller = new AbortController();
    const reason = new DOMException("User left", "AbortError");
    controller.abort(reason);
    await expect(client.encrypt(new Uint8Array(), new Uint8Array(), controller.signal)).rejects.toBe(reason);
});

it("Given a device identity, when private key export is attempted, then its key material stays non-exportable", async () => {
    const identity = await generateE2EIdentity();
    await expect(crypto.subtle.exportKey("pkcs8", identity.privateKey)).rejects.toMatchObject({
        name: "InvalidAccessError",
    });
    expect(await crypto.subtle.exportKey("raw", identity.publicKey)).toHaveProperty("byteLength", 65);
});

it("Given visible routing metadata, when the relay changes the request address, then authentication fails", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const frame = await forgePacket(client, { kind: "session.prompt", prompt: "private prompt" }, signal, {
        requestId: "request-1",
    });
    const envelope = frameRecord(frame);
    if (typeof envelope["encrypted"] !== "string") {
        throw new Error("Expected ciphertext");
    }
    expect(envelope["requestId"]).toBe("request-1");
    await expect(
        decryptPacket(computer, JSON.stringify({ ...envelope, requestId: "request-2" }), signal),
    ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
});

it("Given two browsers with the same Computer capability, when authenticated bytes cross an untrusted hop, then both can read the Computer's response", async () => {
    const hop = await opaqueHop();
    const { client, computer, access } = await endpoints();
    const signal = new AbortController().signal;
    const secondBrowser = await createClientPayloadEncryption(access, signal);
    const request = new TextEncoder().encode("private Computer request");
    const associatedData = new TextEncoder().encode(JSON.stringify({ requestId: "request-1" }));
    const encodedRequest = await client.encrypt(request, associatedData, signal);
    expect(await computer.decrypt(await hop.transfer(encodedRequest), associatedData, signal)).toEqual(request);
    const reply = new TextEncoder().encode("private Computer response");
    const encodedReply = await computer.encrypt(reply, associatedData, signal);
    const observed = await hop.transfer(encodedReply, "daemon");
    expect(await client.decrypt(observed, associatedData, signal)).toEqual(reply);
    expect(await secondBrowser.decrypt(observed, associatedData, signal)).toEqual(reply);
    for (const frame of hop.frames) {
        expect(frame).not.toContain(new TextDecoder().decode(request));
        expect(frame).not.toContain(access.computerE2EAccessSecret);
        expect(frame).not.toContain(new TextDecoder().decode(reply));
    }
});

it("Given a claimed request, when the Computer context is reopened, then the same packet is rejected", async () => {
    const { client, computer, openComputer } = await endpoints();
    const signal = new AbortController().signal;
    const encoded = await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal);
    await decryptPacket(computer, encoded, signal);
    computer.close();
    await expect(decryptPacket(await openComputer(), encoded, signal)).rejects.toMatchObject({
        code: "e2e_invalid_frame",
    });
});

it("Given an expired request, when it reaches the Computer, then it is rejected before execution", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const encoded = await forgePacket(client, { kind: "session.prompt", prompt: "hello" }, signal);
    vi.setSystemTime(new Date("2026-11-12T00:05:00Z"));
    await expect(decryptPacket(computer, encoded, signal)).rejects.toMatchObject({ code: "e2e_invalid_frame" });
});

it("Given a long-lived Computer connection, when a nonce ages out and the clock moves backward, then later traffic succeeds and the old response remains rejected", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = new TextEncoder().encode("routing");
    const first = await computer.encrypt(new TextEncoder().encode("first"), routing, signal);
    expect(new TextDecoder().decode(await client.decrypt(first, routing, signal))).toBe("first");
    vi.setSystemTime(new Date("2026-11-12T00:04:31Z"));
    const later = await computer.encrypt(new TextEncoder().encode("later"), routing, signal);
    expect(new TextDecoder().decode(await client.decrypt(later, routing, signal))).toBe("later");
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    await expect(client.decrypt(first, routing, signal)).rejects.toMatchObject({ code: "e2e_invalid_frame" });
});

it("Given a response issued within the permitted future skew, when its retention window passes, then a clock rollback cannot replay it", async () => {
    const { client, computer } = await endpoints();
    const signal = new AbortController().signal;
    const routing = new TextEncoder().encode("routing");
    vi.setSystemTime(new Date("2026-11-12T00:00:30Z"));
    const future = await computer.encrypt(new TextEncoder().encode("future"), routing, signal);
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    expect(new TextDecoder().decode(await client.decrypt(future, routing, signal))).toBe("future");
    vi.setSystemTime(new Date("2026-11-12T00:05:01Z"));
    const later = await computer.encrypt(new TextEncoder().encode("later"), routing, signal);
    expect(new TextDecoder().decode(await client.decrypt(later, routing, signal))).toBe("later");
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    await expect(client.decrypt(future, routing, signal)).rejects.toMatchObject({ code: "e2e_invalid_frame" });
});
