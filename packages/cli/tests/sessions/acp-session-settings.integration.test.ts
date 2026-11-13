import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { NullSessionObserver } from "../../src/engine/session/api/session-api.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

import { createControlledSession } from "./acp-controls-fixture.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

describe("Agent setting capabilities", () => {
    it("Given an Agent reports its reasoning effort as the provider default, When a session is prepared, Then Morty keeps the effort setting with that current value", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
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
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--effort-provider-default"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );
        const session = await manager.createSession({
            agent,
            cwd: process.cwd(),
            signal: new AbortController().signal,
        });

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        currentValue: "",
                        id: "reasoning_effort",
                        type: "select",
                        values: expect.arrayContaining([expect.objectContaining({ value: "" })]),
                    }),
                ]),
            );
            const effort = prepared.configOptions.find((option) => option.id === "reasoning_effort");
            expect(effort?.type === "select" ? effort.values.map((value) => value.value) : []).toEqual([
                "",
                "low",
                "medium",
                "high",
            ]);
            const configured = await manager.applySessionConfiguration({
                ...session,
                configId: "reasoning_effort",
                requestId: "provider-default-to-high",
                value: "high",
                type: "select",
            });
            expect(configured.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ currentValue: "high", id: "reasoning_effort", type: "select" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent does not expose adjustable reasoning effort, When a session is prepared, Then Morty does not invent an effort setting", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
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
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--without-reasoning-effort"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );
        const session = await manager.createSession({
            agent,
            cwd: process.cwd(),
            signal: new AbortController().signal,
        });

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
            await expect(
                manager.applySessionConfiguration({
                    ...session,
                    configId: "reasoning_effort",
                    requestId: "unavailable-effort",
                    value: "high",
                    type: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });

    it("Given Pi exposes no approval or sandbox setting, When its session is prepared, Then Morty exposes no synthetic execution control", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
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
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "pi",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--without-model", "--without-reasoning-effort"],
                        environment: options.environment,
                    },
                    options,
                ),
            "pi",
            "Pi",
            process.execPath,
        );

        try {
            const prepared = await manager.prepareSession({
                agent,
                cwd: process.cwd(),
                target: await manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });
            expect(prepared.configOptions).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "model" }),
                    expect.objectContaining({ id: "permission_mode" }),
                    expect.objectContaining({ id: "reasoning_effort" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent acknowledges a setting without applying it, When Morty configures the session, Then the Turn is rejected", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
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
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "fake",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--ignore-config-update"],
                        environment: options.environment,
                    },
                    options,
                ),
            "fake",
            "Fake",
            process.execPath,
        );
        const session = await manager.createSession({
            agent,
            cwd: process.cwd(),
            signal: new AbortController().signal,
        });

        try {
            await manager.prepareSession(session);
            await expect(
                manager.applySessionConfiguration({
                    ...session,
                    configId: "model",
                    requestId: "ignored-model-update",
                    value: "test-large",
                    type: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });
});

it("Given ACP exposes select and boolean settings, When a user configures the conversation, Then the next prompt executes with those values", async () => {
    await using session = await createControlledSession();
    const prepared = await session.manager.prepareSession(session.request);
    expect(prepared).toMatchObject({
        agentName: "Morty test agent",
        capabilities: {
            embeddedContextPrompt: true,
            imagePrompt: true,
            loadSession: true,
            promptQueueing: true,
            resumeSession: true,
            steering: true,
        },
        restored: false,
    });
    expect(prepared.configOptions).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ category: "mode", id: "mode" }),
            expect.objectContaining({ category: "model", id: "model" }),
            expect.objectContaining({
                category: "thought_level",
                id: "reasoning_effort",
            }),
            expect.objectContaining({ id: "fast_mode", type: "boolean" }),
        ]),
    );

    for (const [configId, value] of [
        ["model", "test-large"],
        ["mode", "plan"],
        ["reasoning_effort", "high"],
    ] as const) {
        const configured = await session.manager.applySessionConfiguration({
            ...session.request,
            configId,
            value,
            type: "select",
            requestId: `configure-${configId}`,
        });
        expect(configured.configOptions).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: configId, currentValue: value })]),
        );
    }
    await session.manager.applySessionConfiguration({
        ...session.request,
        configId: "fast_mode",
        booleanValue: true,
        type: "boolean",
        requestId: "configure-fast-mode",
    });

    await expect(
        session.manager.runPrompt({
            ...session.request,
            commandId: "configured-command",
            prompt: "Report execution settings",
            images: [],
            resources: [],
        }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(session.observer.agentText()).toBe("plan test-large high fast");
});
