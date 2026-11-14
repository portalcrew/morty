import { base64urlnopad } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
} from "../../src/encryption.ts";
import { sessionPromptCommandCodec } from "../../src/protocol/index.ts";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("Given distinct prompt request and Turn IDs, when it crosses the encrypted boundary, then replies use the request ID and both identities survive", async () => {
    const signal = new AbortController().signal;
    const identity = await generateE2EIdentity();
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(7)),
    };
    const seen = new Set<string>();
    const client = await createClientPayloadEncryption(access, signal);
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim) => {
            if (seen.has(claim.fingerprint)) {
                throw new Error("Duplicate claim");
            }
            seen.add(claim.fingerprint);
        },
        signal,
    );
    try {
        const message = {
            kind: "session.prompt" as const,
            requestId: "request-1",
            commandId: "turn-1",
            target: { harness: "codex", sessionId: "session-1" },
            prompt: "private",
            attachments: [],
            disposition: "append" as const,
        };
        const wire = await sessionPromptCommandCodec.encode(message, client, signal);
        const routing = sessionPromptCommandCodec.decodeRouting(wire);
        expect(routing).toMatchObject({ requestId: "request-1", commandId: "turn-1" });
        await expect(
            sessionPromptCommandCodec.decode(JSON.stringify({ ...routing, requestId: "request-2" }), computer, signal),
        ).rejects.toMatchObject({ code: "e2e_authentication_failed" });
        const decoded = await sessionPromptCommandCodec.decode(wire, computer, signal);
        expect(decoded).toEqual(message);
        await expect(
            sessionPromptCommandCodec.encode({ ...message, requestId: undefined }, client, signal),
        ).rejects.toMatchObject({ code: "invalid_protocol_message" });
    } finally {
        client.close();
        computer.close();
    }
});
