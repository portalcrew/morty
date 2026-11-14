import {
    readUndecodedRequestAddress,
    type SessionPromptCommand,
    sessionPromptCommandCodec,
} from "@morty-build/client/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestPayloadEncryption } from "../support/payload-encryption.ts";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const prompt: SessionPromptCommand = {
    commandId: "command-1",
    requestId: "command-1",
    attachments: [],
    disposition: "append",
    kind: "session.prompt",
    prompt: "Hello",
    target: { harness: "agent-1", sessionId: "session-1" },
};

it("Given a prompt, When it crosses the encrypted protocol boundary, Then its request and Turn addresses are retained", async () => {
    const { client, computer, signal } = await openTestPayloadEncryption();
    const encoded = await sessionPromptCommandCodec.encode(prompt, client, signal);
    expect(sessionPromptCommandCodec.decodeRouting(encoded)).toMatchObject({
        requestId: prompt.requestId,
        commandId: prompt.commandId,
    });
    const decoded = await sessionPromptCommandCodec.decode(encoded, computer, signal);
    expect(decoded).toEqual(prompt);
});

it("Given a prompt omits requestId, When it is encoded, Then it is rejected", async () => {
    const { requestId: _, ...missingRequestId } = prompt;
    const { client, signal } = await openTestPayloadEncryption();
    await expect(sessionPromptCommandCodec.encode(missingRequestId, client, signal)).rejects.toThrow();
});

it("Given a prompt with an invalid requestId, When it crosses the protocol boundary, Then it is rejected", async () => {
    const { client, signal } = await openTestPayloadEncryption();
    for (const requestId of ["", null, 42]) {
        await expect(sessionPromptCommandCodec.encode({ ...prompt, requestId }, client, signal)).rejects.toThrow();
    }
});

it("Given a prompt with a separate requestId, When it crosses the protocol boundary, Then it keeps the Turn identity and addresses the reply independently", async () => {
    const request = { ...prompt, requestId: "another-request" };
    const { client, computer, signal } = await openTestPayloadEncryption();
    const encoded = await sessionPromptCommandCodec.encode(request, client, signal);
    const decoded = await sessionPromptCommandCodec.decode(encoded, computer, signal);
    expect(decoded).toEqual(request);
});

it("Given an invalid prompt with a requestId, When its refusal is addressed, Then the reply uses the explicit requestId", () => {
    expect(readUndecodedRequestAddress(JSON.stringify({ ...prompt, requestId: "request-2", prompt: "" }))).toEqual({
        requestId: "request-2",
        target: prompt.target,
    });
});
