import { describe, expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { completeAcpControls, createControlledSession } from "./acp-controls-fixture.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp interactions", () => {
    it("Given an Agent turn is running, When a targeted steering prompt is submitted, Then it is injected into that exact turn and preserves the Agent message anchor", async () => {
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            lastTurn: () => undefined,
            settledTurns: () => [],
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const signal = new AbortController().signal;
        try {
            const target = await manager.createNativeSession({
                agent: fakeAgent(),
                cwd: process.cwd(),
                signal,
            });
            const running = manager.runPrompt({
                agent: fakeAgent(),
                commandId: "running-command",
                cwd: process.cwd(),
                images: [],
                lifecycle: {
                    attemptId: "steering-attempt",
                    content: [{ text: "wait for steering", type: "text" }],
                    dispatch: { kind: "own" },
                },
                prompt: "wait for steering",
                resources: [],
                target,
                signal,
            });
            const finishedBeforeStart = running.then(() => {
                throw new Error("The steering target completed before its structured content arrived");
            });
            await Promise.race([
                observer.waitForEvent(
                    (event) =>
                        event.type === "acp" &&
                        (event.payload.sessionUpdate === "agent_message_chunk" ||
                            event.payload.sessionUpdate === "user_message_chunk" ||
                            event.payload.sessionUpdate === "agent_thought_chunk") &&
                        event.payload.content.type !== "text",
                ),
                finishedBeforeStart,
            ]);

            await expect(
                manager.steerPrompt({
                    agent: fakeAgent(),
                    commandId: "steering-command",
                    cwd: process.cwd(),
                    images: [],
                    lifecycle: {
                        attemptId: "steering-attempt-2",
                        content: [{ text: "focus on the requested fix", type: "text" }],
                        dispatch: { kind: "steer", targetCommandId: "running-command" },
                    },
                    prompt: "focus on the requested fix",
                    resources: [],
                    target,
                    signal,
                    targetCommandId: "running-command",
                }),
            ).resolves.toBe("injected");
            await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
            expect(observer.agentText()).toContain("Steered: focus on the requested fix");
        } finally {
            await manager.close();
        }
    });

    it("Given ACP requests permission followed by a form, When the user allows and submits a branch, Then both interactions remain correlated and the prompt consumes the response", async () => {
        await using session = await createControlledSession();
        const result = await completeAcpControls(session);
        expect(result.permission).toMatchObject({
            commandId: "controls-command",
            title: "Run the verification command",
        });
        expect(result.elicitation).toMatchObject({
            fields: [expect.objectContaining({ name: "branch", required: true })],
            mode: "form",
        });
        expect(result.completed).toEqual({
            stopReason: "end_turn",
            _meta: { messageId: "user-1" },
        });
        expect(result.text).toContain("main");
        const retry = {
            action: "accept" as const,
            content: ' { "branch" : "main" } ',
            interactionId: result.elicitation.interactionId,
            target: session.request.target,
        };
        await expect(session.manager.respondElicitation(retry)).resolves.toBeUndefined();
        await expect(
            session.manager.respondElicitation({ ...retry, content: '{"branch":"other"}' }),
        ).rejects.toMatchObject({
            code: "elicitation_response_conflict",
        });
        await expect(session.manager.respondElicitation({ ...retry, action: "decline" })).rejects.toMatchObject({
            code: "elicitation_response_conflict",
        });

        expect(
            session.observer.events.flatMap(({ event }) =>
                event.type === "lifecycle-metadata" ? [event.payload.kind] : [],
            ),
        ).toEqual([
            "prompt.requested",
            "prompt.started",
            "session.permission.requested",
            "session.permission.resolved",
            "session.elicitation.requested",
            "session.elicitation.resolved",
            "prompt.completed",
        ]);
        expect(session.observer.events.map(({ position }) => position)).toEqual(
            session.observer.events.map(({ position }) => position).toSorted((left, right) => left - right),
        );
    });

    it("Given URL elicitation, When the user consents and the agent reports completion, Then the out-of-band interaction stays correlated through completion", async () => {
        await using session = await createControlledSession();
        const running = session.manager.runPrompt({
            ...session.request,
            commandId: "url-command",
            prompt: "exercise URL elicitation",
            images: [],
            resources: [],
        });
        const elicitation = await Promise.race([
            session.observer.elicitationArrived.promise,
            running.then(() => {
                throw new Error("The prompt completed before URL elicitation");
            }),
        ]);
        expect(elicitation).toMatchObject({
            accepted: false,
            mode: "url",
            url: expect.stringContaining("https://example.com/connect/"),
        });
        await session.manager.respondElicitation({
            action: "accept",
            content: "",
            interactionId: elicitation.interactionId,
            target: session.request.target,
        });
        await expect(running).resolves.toEqual({
            stopReason: "end_turn",
            _meta: { messageId: "user-1" },
        });
        await expect(
            session.manager.respondElicitation({
                action: "accept",
                content: "",
                interactionId: elicitation.interactionId,
                target: session.request.target,
            }),
        ).resolves.toBeUndefined();
        expect(session.observer.elicitationResolutions.map((event) => event.action)).toEqual(["accept", "complete"]);
    });
});
