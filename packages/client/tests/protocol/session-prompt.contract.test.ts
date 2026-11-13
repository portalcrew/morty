import {
    decodeSessionPromptCommand,
    encodeSessionPromptCommand,
    readUndecodedRequestAddress,
    requestReplyAddress,
    type SessionPromptCommand,
} from "@morty-build/client/protocol";
import { expect, it } from "vitest";

const prompt: SessionPromptCommand = {
    commandId: "command-1",
    requestId: "command-1",
    attachments: [],
    disposition: "append",
    kind: "session.prompt",
    prompt: "Hello",
    target: { harness: "agent-1", sessionId: "session-1" },
};

it("Given a prompt, When it crosses the protocol boundary, Then requestId is emitted next to commandId with the same value", () => {
    const encoded = encodeSessionPromptCommand(prompt);
    expect(JSON.parse(encoded)).toEqual({ ...prompt, requestId: prompt.commandId });
    expect(encoded).toContain('"commandId":"command-1","requestId":"command-1"');
    expect(requestReplyAddress(decodeSessionPromptCommand(encoded))).toBe(prompt.commandId);
});

it("Given a prompt omits requestId, When it is decoded, Then it is rejected", () => {
    const { requestId: _, ...missingRequestId } = prompt;
    expect(() => decodeSessionPromptCommand(JSON.stringify(missingRequestId))).toThrow();
});

it("Given a prompt with a conflicting or invalid requestId, When it crosses the protocol boundary, Then it is rejected", () => {
    for (const requestId of ["another-request", "", null, 42]) {
        expect(() => decodeSessionPromptCommand(JSON.stringify({ ...prompt, requestId }))).toThrow();
    }
});

it("Given an invalid prompt with a requestId, When its refusal is addressed, Then the reply uses the explicit requestId", () => {
    expect(readUndecodedRequestAddress(JSON.stringify({ ...prompt, requestId: "request-2", prompt: "" }))).toEqual({
        requestId: "request-2",
        target: prompt.target,
    });
});
