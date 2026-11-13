import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { NullSessionObserver } from "../../src/engine/session/api/session-api.ts";
import { MemorySessionEventStore } from "../../src/engine/session/history/session-event-store.ts";
import { MemorySessionStore, SqliteSessionStore } from "../../src/engine/session/record/session-store.ts";
import { AcpSessionTable } from "../../src/engine/storage/session/acp-session-table.ts";
import { openAcpSessionDatabase } from "../../src/engine/storage/sqlite/local-databases.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgentPath } from "./acp-feature-fixture.ts";

async function controlledAgent(
    harness: string,
    additionalArguments: readonly string[] = [],
): Promise<{ agent: AcpAgentDefinition; stateDirectory: string }> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-session-config-reads-"));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: harness,
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, ...additionalArguments],
                    environment: options.environment,
                },
                options,
            ),
        harness,
        "Controlled ACP",
        process.execPath,
        {
            MORTY_FAKE_ACP_STATE_DIRECTORY: stateDirectory,
        },
    );
    return { agent, stateDirectory };
}

function createManager(store: MemorySessionStore | SqliteSessionStore): SessionManager {
    return new SessionManager({
        observer: new NullSessionObserver(),
        store,
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
}

describe("Session settings reads after a daemon restart", () => {
    it("Given a stored session, When an unknown session is read, Then the lookup reports it missing", async () => {
        const manager = createManager(new MemorySessionStore());
        try {
            expect(manager.findSessions([{ harness: "claude", sessionId: "missing-session" }])).toHaveLength(0);
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent without history loading, When its stored session's settings are read through the config-read path, Then the read resolves with the current configuration", async () => {
        // The controlled peer advertises loadSession: false with this flag, so
        // any history-required preparation would fail with
        // native_history_unsupported before reaching the configuration.
        const { agent } = await controlledAgent("controlled-config-read", ["--no-load-session"]);
        const store = new MemorySessionStore();
        const manager = createManager(store);
        const sessionTarget = await manager.createNativeSession({
            agent,
            cwd: process.cwd(),
            signal: AbortSignal.timeout(10_000),
        });
        try {
            await manager.runPrompt({
                agent,
                commandId: "no-load-config-read-command",
                cwd: process.cwd(),
                images: [],
                resources: [],
                target: sessionTarget,
                prompt: "Complete this turn",
                signal: AbortSignal.timeout(10_000),
            });
        } finally {
            // Retiring the process leaves the stored row; the read must still
            // work without ever loading history.
            await manager.close();
        }

        const reader = createManager(store);
        try {
            const [found] = reader.findSessions([sessionTarget]);
            expect(found?.target).toEqual(sessionTarget);
            // The history-required path the read must not use: without load
            // support it fails before any configuration is reachable.
            await expect(
                reader.restoreSession({
                    agent,
                    cwd: process.cwd(),
                    target: sessionTarget,
                    signal: AbortSignal.timeout(10_000),
                }),
            ).rejects.toMatchObject({ code: "native_history_unsupported" });
            const prepared = await reader.prepareSession({
                agent,
                cwd: process.cwd(),
                target: sessionTarget,
                signal: AbortSignal.timeout(10_000),
            });
            const model = prepared.configOptions.find((option) => option.id === "model");
            if (model?.type !== "select") {
                throw new Error("Expected the fake peer to report a model select option");
            }
            expect(model.currentValue).toBe("test-small");
        } finally {
            await reader.close();
        }
    });

    it("Given a native chat session whose process the daemon retired, When it is looked up after a restart, Then it is still known with its title and a prepare restores its configured settings", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-config-read-retired-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const { agent, stateDirectory } = await controlledAgent("claude");
        const seed = createManager(new MemorySessionStore());
        const sessionTarget = await seed.createNativeSession({
            agent,
            cwd: process.cwd(),
            signal: AbortSignal.timeout(10_000),
        });
        await seed.close();
        const store = new SqliteSessionStore(
            new AcpSessionTable(openAcpSessionDatabase(databasePath)),
            new MemorySessionEventStore(),
        );
        const first = createManager(store);
        try {
            const imported = await first.openNativeSession(
                {
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                },
                { kind: "import", sessionId: sessionTarget.sessionId, title: "Imported native session" },
            );
            expect(imported.target).toEqual(sessionTarget);
            await first.runPrompt({
                agent,
                commandId: "config-read-retired-command",
                cwd: process.cwd(),
                images: [],
                resources: [],
                target: sessionTarget,
                prompt: "Complete this turn",
                signal: AbortSignal.timeout(10_000),
            });
            // Configure a model so a later read has a non-default value to find.
            await first.applySessionConfiguration({
                agent,
                configId: "model",
                cwd: process.cwd(),
                requestId: "config-read-retired-configure",
                target: sessionTarget,
                signal: AbortSignal.timeout(10_000),
                value: "test-large",
                type: "select",
            });
        } finally {
            // Closing the daemon retires the Session's process; the Session itself outlives it.
            await first.close();
        }

        const restarted = createManager(store);
        try {
            const [found] = restarted.findSessions([sessionTarget]);
            expect(found).toMatchObject({ target: sessionTarget, title: "Imported native session", prompted: true });
            const prepared = await restarted.prepareSession({
                agent,
                cwd: process.cwd(),
                target: sessionTarget,
                signal: AbortSignal.timeout(10_000),
            });
            const model = prepared.configOptions.find((option) => option.id === "model");
            if (model?.type !== "select") {
                throw new Error("Expected the fake peer to report a model select option");
            }
            expect(model.currentValue).toBe("test-large");
        } finally {
            await restarted.close();
            await rm(stateDirectory, { force: true, recursive: true });
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
