import {
    decodeDaemonToServiceMessage,
    decodeNativeSessionResult,
    decodeServiceToDaemonMessage,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
} from "@morty-build/client/protocol";
import { describe, expect, it } from "vitest";

describe("Session config read contracts", () => {
    it("Given a config read command, When it crosses the daemon boundary, Then it round-trips", () => {
        const command = {
            kind: SESSION_CONFIG_READ_KIND,
            requestId: "request-config-1",
            target: { harness: "claude", sessionId: "session-1" },
        } as const;
        const encoded = encodeServiceToDaemonMessage(command);
        expect(decodeServiceToDaemonMessage(encoded)).toEqual(command);
    });

    it("Given a config read result, When it crosses the daemon boundary, Then it round-trips", () => {
        const result = {
            configOptions: [
                {
                    category: "model",
                    currentValue: "test-large",
                    description: "Model",
                    id: "model",
                    name: "Model",
                    type: "select",
                    values: [
                        { description: "", groupId: "", groupName: "", name: "Test Small", value: "test-small" },
                        { description: "", groupId: "", groupName: "", name: "Test Large", value: "test-large" },
                    ],
                },
            ],
            configurationRevision: "revision-1",
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: "request-config-1",
            target: { harness: "claude", sessionId: "session-1" },
        } as const;
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });
});

describe("Session execution read contracts", () => {
    const execution = {
        action: "active-turn",
        executionPosition: { sessionGenerationId: "generation-1", throughPosition: "4" },
        kind: "native.session.result",
        queued: [],
        interactionState: null,
        requestId: "request-execution-1",
        target: { harness: "claude", sessionId: "session-1" },
        turn: null,
    } as const;

    it("Given an execution that reports a running turn and a last turn, When it crosses the launch protocol boundary, Then it is rejected, since a last turn is told only while none runs", () => {
        const turn = {
            commandId: "command-1",
            epoch: "epoch-1",
            interaction: null,
            sequence: 1,
            startedAt: "2026-11-13T00:00:00.000Z",
            state: "running",
        };
        const lastTurn = { commandId: "command-0", state: "completed", stopReason: "end_turn" };
        expect(decodeNativeSessionResult(JSON.stringify({ ...execution, turn }))).toMatchObject({ turn });
        expect(() => decodeNativeSessionResult(JSON.stringify({ ...execution, turn, lastTurn }))).toThrow();
        expect(decodeNativeSessionResult(JSON.stringify({ ...execution, lastTurn }))).toMatchObject({ lastTurn });
    });

    it("Given an execution with an unknown command delivery state, When it crosses the launch protocol boundary, Then the malformed snapshot is rejected", () => {
        expect(() =>
            decodeNativeSessionResult(
                JSON.stringify({ ...execution, command: { state: "superseded", by: "command-2" } }),
            ),
        ).toThrow();
    });

    it("Given an execution with an unknown last turn outcome, When it crosses the launch protocol boundary, Then the malformed snapshot is rejected", () => {
        expect(() =>
            decodeNativeSessionResult(
                JSON.stringify({ ...execution, lastTurn: { commandId: "command-1", state: "abandoned" } }),
            ),
        ).toThrow();
    });

    it("Given an execution missing current interaction recovery, When it crosses the launch protocol boundary, Then an older snapshot cannot silently clear pending requests", () => {
        const { interactionState: _interactionState, ...oldSnapshot } = execution;
        expect(() => decodeNativeSessionResult(JSON.stringify(oldSnapshot))).toThrow();
    });

    it("Given an execution without the log position it covers, When it crosses the launch protocol boundary, Then the unordered snapshot is rejected", () => {
        const { executionPosition: _executionPosition, ...unordered } = execution;
        expect(() => decodeNativeSessionResult(JSON.stringify(unordered))).toThrow();
    });

    it("Given an execution with a known command delivery, When it is decoded, Then the delivery is kept", () => {
        expect(
            decodeNativeSessionResult(JSON.stringify({ ...execution, command: { state: "failed", code: "boom" } })),
        ).toMatchObject({ command: { state: "failed", code: "boom" } });
    });
    it("Given a running turn without its start time, When a client restores execution, Then the retired snapshot is rejected", () => {
        expect(() =>
            decodeNativeSessionResult(
                JSON.stringify({
                    ...execution,
                    turn: {
                        commandId: "command-1",
                        epoch: "epoch-1",
                        interaction: null,
                        sequence: 0,
                        state: "running",
                    },
                }),
            ),
        ).toThrow();
    });
});
