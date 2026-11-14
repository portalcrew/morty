import {
    decodeAgentSettingsDiscoveredEvent,
    decodeKnownSessionEventLogPage,
    decodeSessionPermissionRequestedEvent,
    decodeSessionsListedEvent,
} from "@morty-build/client/protocol";
import { expect, it } from "vitest";

it("Given a permission request without its execution context, When it crosses the Computer boundary, Then the retired form is rejected", () => {
    const permission = {
        kind: "session.permission.requested",
        commandId: "command-1",
        interactionId: "interaction-1",
        target: { harness: "agent-1", sessionId: "session-1" },
        title: "Read file",
        toolCallId: "tool-1",
        toolKind: "read",
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
    };
    expect(() => decodeSessionPermissionRequestedEvent(JSON.stringify(permission))).toThrow();
    const current = { ...permission, details: { cwd: "/workspace", locations: [] } };
    expect(decodeSessionPermissionRequestedEvent(JSON.stringify(current))).toEqual(current);
});

it("Given Agent settings without the inspected directory, When a client decodes them, Then it rejects the retired response instead of applying settings to another directory", () => {
    const settings = {
        kind: "agent.settings.discovered",
        harness: "agent-1",
        agentName: "Claude",
        agentVersion: "2",
        requestId: "request-1",
        settings: [],
        settingsRevision: "a".repeat(64),
    };
    expect(() => decodeAgentSettingsDiscoveredEvent(JSON.stringify(settings))).toThrow();
    const current = { ...settings, directory: "." };
    expect(decodeAgentSettingsDiscoveredEvent(JSON.stringify(current))).toEqual(current);
});

it("Given history holding a turn's lifecycle, When a client decodes it, Then the lifecycle stays in page order", () => {
    const fields = { recordedAt: "2026-11-08T00:00:00.000Z" };
    const page = {
        events: [
            {
                ...fields,
                eventId: "started",
                payload: { attemptId: "attempt-1", commandId: "command-1", kind: "prompt.started" },
                type: "lifecycle-metadata",
            },
            {
                ...fields,
                eventId: "message",
                payload: {
                    content: { text: "Hello", type: "text" },
                    messageId: "message-1",
                    sessionUpdate: "user_message_chunk",
                },
                type: "acp",
            },
            {
                ...fields,
                eventId: "completed",
                payload: {
                    commandId: "command-1",
                    completion: { kind: "ended", stopReason: "end_turn" },
                    kind: "prompt.completed",
                },
                type: "lifecycle-metadata",
            },
        ],
        nextCursor: null,
        sessionGenerationId: "generation-1",
        throughPosition: "3",
    };
    expect(decodeKnownSessionEventLogPage(JSON.stringify(page))).toEqual(page);
});
it("Given a session list entry without status, When a client decodes it, Then it rejects the retired entry", () => {
    const entry = {
        directory: ".",
        directoryLabel: "Workspace",
        prompted: false,
        target: { harness: "agent-1", sessionId: "session-1" },
        title: "Session",
        updatedAt: "2026-11-07T00:00:00.000Z",
    };
    const page = { kind: "session.listed", entries: [entry], requestId: "request-1" };
    expect(() => decodeSessionsListedEvent(JSON.stringify(page))).toThrow();
    const current = { ...page, entries: [{ ...entry, status: { kind: "idle" } }] };
    expect(decodeSessionsListedEvent(JSON.stringify(current))).toEqual(current);
});
