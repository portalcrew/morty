import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { describe, expect, it, vi } from "vitest";
import { openPreviewEventCache } from "../../src/engine/acp/adapter/preview-event-cache.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { acpSessionStoreMigrations } from "../../src/engine/generated/acp-session-store-migrations.ts";
import { NullSessionObserver } from "../../src/engine/session/api/session-api.ts";
import { SqliteSessionLiveEventPosition } from "../../src/engine/session/history/live-event-positions.ts";
import {
    CachedSessionEventStore,
    MemorySessionEventStore,
} from "../../src/engine/session/history/session-event-store.ts";
import { MemorySessionStore, SqliteSessionStore } from "../../src/engine/session/record/session-store.ts";
import { AcpSessionTable } from "../../src/engine/storage/session/acp-session-table.ts";
import { LiveEventPositionTable } from "../../src/engine/storage/session/live-event-position-table.ts";
import { SessionEventCacheTable } from "../../src/engine/storage/session/session-event-cache-table.ts";
import {
    openAcpSessionDatabase,
    openSessionEventCacheDatabase,
} from "../../src/engine/storage/sqlite/local-databases.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { readExecutableIdentity } from "../support/agent-definition.ts";
import { createWritableAcpStream } from "../support/agents/acp-stream.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { RecordingObserver } from "./acp-feature-fixture.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
const recordedTarget = { harness: "codex", sessionId: "session-1" };

function processExists(pid: number): boolean {
    if (process.platform === "linux") {
        try {
            const encoded = readFileSync(join("/proc", pid.toString(), "stat"), "utf8");
            const closingParenthesis = encoded.lastIndexOf(")");
            const state = encoded
                .slice(closingParenthesis + 1)
                .trimStart()
                .charAt(0);
            if (state === "Z" || state === "X") {
                return false;
            }
        } catch {
            // Fall through when procfs is unavailable or the process has already exited.
        }
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

describe("ACP conversation sessions", () => {
    it("Given a prompt that already finished, When its cancellation arrives late, Then the next prompt in the conversation still runs", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-late-cancel-"));
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Codex"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
            { MORTY_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
        );
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            lastTurn: () => undefined,
            settledTurns: () => [],
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({ ...content, target: sessionTarget, signal }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const target = await manager.createNativeSession({
            agent,
            cwd: temporaryDirectory,
            signal: AbortSignal.timeout(10_000),
        });
        const prompt = (commandId: string) =>
            manager.runPrompt({
                agent,
                commandId,
                cwd: temporaryDirectory,
                images: [],
                prompt: commandId,
                resources: [],
                target,
                signal: new AbortController().signal,
            });

        try {
            await expect(prompt("finished-command")).resolves.toMatchObject({ stopReason: "end_turn" });
            await manager.cancelPrompt(target, "finished-command");

            await expect(prompt("next-command")).resolves.toMatchObject({ stopReason: "end_turn" });
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an inactive existing conversation, When it is reopened, Then its directory activity time stays unchanged", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const store = new MemorySessionStore();
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-activity-time-"));
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Codex"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
            { MORTY_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
        );
        const firstManager = new SessionManager({
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
        const signal = new AbortController().signal;

        try {
            vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
            const target = await firstManager.createNativeSession({
                agent,
                cwd: process.cwd(),
                signal,
            });
            await firstManager.runPrompt({
                agent,
                commandId: "initial-command",
                cwd: process.cwd(),
                images: [],
                prompt: "initial activity",
                resources: [],
                target,
                signal,
            });
            const initial = store.read(target);
            if (initial === undefined) {
                throw new Error("Expected the conversation to be stored");
            }
            await firstManager.close();

            vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
            const reopenedManager = new SessionManager({
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
            try {
                await reopenedManager.prepareSession({
                    agent,
                    cwd: process.cwd(),
                    target,
                    signal,
                });
                const reopened = store.read(target);
                if (reopened === undefined) {
                    throw new Error("Expected the reopened conversation to remain stored");
                }
                expect(reopened.updatedAt).toBe(initial.updatedAt);

                await reopenedManager.runPrompt({
                    agent,
                    commandId: "new-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "new activity",
                    resources: [],
                    target,
                    signal,
                });
                const active = store.read(target);
                if (active === undefined) {
                    throw new Error("Expected the active conversation to remain stored");
                }
                // Activity preserves the Agent's reported modification time rather than the Computer clock.
                expect(active.updatedAt).toBe("2026-09-05T00:00:00Z");
            } finally {
                await reopenedManager.close();
            }
        } finally {
            vi.useRealTimers();
            await firstManager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a projected tool has flushed to SQLite, When more live updates arrive, Then history replaces that Session event while keeping the projected live identity", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-tool-projection-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite"))),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
        try {
            const liveEvents = [
                store.append(recordedTarget, {
                    payload: {
                        sessionUpdate: "tool_call",
                        title: "Run command",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            ];
            liveEvents.push(
                store.append(recordedTarget, {
                    payload: {
                        rawOutput: { output: "first snapshot" },
                        sessionUpdate: "tool_call_update",
                        status: "in_progress",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            );
            for (let remaining = 298; remaining > 0; remaining -= 1) {
                store.append(recordedTarget, {
                    payload: {
                        content: { text: "history", type: "text" },
                        messageId: `message-${remaining}`,
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                });
            }
            await vi.runAllTimersAsync();

            liveEvents.push(
                store.append(recordedTarget, {
                    payload: {
                        content: [{ content: { text: "final snapshot", type: "text" }, type: "content" }],
                        sessionUpdate: "tool_call_update",
                        status: "completed",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            );

            const page = store.page(recordedTarget, 400, null);
            const toolEvents = page.events.filter(
                (event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update"),
            );
            expect(toolEvents).toHaveLength(1);
            expect(toolEvents[0]).toMatchObject({
                payload: {
                    content: [{ content: { text: "final snapshot", type: "text" }, type: "content" }],
                    rawOutput: { output: "first snapshot" },
                    sessionUpdate: "tool_call",
                    status: "completed",
                    title: "Run command",
                    toolCallId: "tool-1",
                },
                type: "acp",
            });
            expect(liveEvents.map((event) => event.eventId)).toContain(toolEvents[0]?.eventId);
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.each(["session", "adapter preview"])(
        "Given %s history far beyond the memory tier, When terminal tool calls accumulate across flushes, Then materialized event payloads stay bounded",
        async (kind) => {
            vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-bounded-"));
            const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
            const previewCache = kind === "adapter preview" ? openPreviewEventCache() : null;
            const store =
                previewCache?.events ??
                new CachedSessionEventStore(
                    new SessionEventCacheTable(
                        openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite")),
                    ),
                    new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
                );
            try {
                for (let number = 1; number <= 3000; number += 1) {
                    if (number % 10 === 1) {
                        store.append(recordedTarget, {
                            payload: {
                                sessionUpdate: "tool_call",
                                title: "Run command",
                                toolCallId: `tool-${number.toString()}`,
                            },
                            type: "acp",
                        });
                        store.append(recordedTarget, {
                            payload: {
                                sessionUpdate: "tool_call_update",
                                status: "completed",
                                toolCallId: `tool-${number.toString()}`,
                            },
                            type: "acp",
                        });
                    } else {
                        store.append(recordedTarget, {
                            payload: {
                                content: { text: "history", type: "text" },
                                messageId: `message-${number}`,
                                sessionUpdate: "user_message_chunk",
                            },
                            type: "acp",
                        });
                    }
                }
                await vi.runAllTimersAsync();

                expect(store.materializedEventCount(recordedTarget)).toBeLessThanOrEqual(256);

                const page = store.page(recordedTarget, 4000, null);
                const eventIds = page.events.map((event) => event.eventId);
                expect(new Set(eventIds).size).toBe(page.events.length);
                expect(page.events).toHaveLength(3000);
                const toolEvents = page.events.filter(
                    (event) => event.type === "acp" && event.payload.sessionUpdate === "tool_call",
                );
                expect(toolEvents).toHaveLength(300);
                for (const event of toolEvents) {
                    if (event.type !== "acp" || event.payload.sessionUpdate !== "tool_call") {
                        throw new Error("Expected merged terminal tool calls");
                    }
                    expect(event.payload.status).toBe("completed");
                }
            } finally {
                store.close();
                previewCache?.close();
                sessionDatabase.close();
                vi.useRealTimers();
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it("Given a previous process filled the event cache database, When a new process opens it, Then the cache file is compact again", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-cache-vacuum-"));
        const databasePath = join(temporaryDirectory, "events.sqlite");
        const sessionDatabasePath = join(temporaryDirectory, "sessions.sqlite");
        const firstSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const first = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databasePath)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(firstSessionDatabase)),
        );
        try {
            for (let number = 1; number <= 2000; number += 1) {
                first.append(recordedTarget, {
                    payload: {
                        messageId: `command-${number.toString()}`,
                        content: { text: "x".repeat(600), type: "text" },
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                });
            }
        } finally {
            first.close();
            firstSessionDatabase.close();
        }
        expect((await stat(databasePath)).size).toBeGreaterThan(512 * 1024);

        const secondSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const second = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databasePath)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(secondSessionDatabase)),
        );
        try {
            second.append(recordedTarget, {
                payload: { kind: "session.queue.changed" },
                type: "lifecycle-metadata",
            });
        } finally {
            second.close();
            secondSessionDatabase.close();
        }
        expect((await stat(databasePath)).size).toBeLessThan(256 * 1024);
        await rm(temporaryDirectory, { force: true, recursive: true });
    });

    it("Given two conversations replay the same deterministic native history, When both page history after flushing, Then each keeps its own full event tier", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-shared-generation-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite"))),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
        const sharedGeneration = "11111111-2222-3333-4444-555555555555";
        const history = Array.from(
            { length: 300 },
            (_unused, index) =>
                ({
                    payload: {
                        messageId: `command-${(index + 1).toString()}`,
                        content: { text: `prompt ${(index + 1).toString()}`, type: "text" },
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                }) as const,
        );
        try {
            store.materialize({ harness: "claude", sessionId: "same-native-session" }, sharedGeneration, history);
            store.materialize({ harness: "codex", sessionId: "same-native-session" }, sharedGeneration, history);
            await vi.runAllTimersAsync();

            for (const conversation of ["conversation-a", "conversation-b"]) {
                const page = store.page(
                    {
                        harness: conversation === "conversation-a" ? "claude" : "codex",
                        sessionId: "same-native-session",
                    },
                    300,
                    null,
                );
                expect(page.events).toHaveLength(300);
                expect(page.sessionGenerationId).toBe(sharedGeneration);
                expect(page.events[0]).toMatchObject({ payload: { messageId: "command-1" } });
                expect(page.events.at(-1)).toMatchObject({ payload: { messageId: "command-300" } });
            }
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given more V2 events than the memory tier retains, When history is paged after background caching, Then one ordered sequence is returned", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-tiering-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite"))),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
        try {
            for (let position = 1; position <= 300; position += 1) {
                store.append(recordedTarget, {
                    payload: {
                        messageId: `command-${position.toString()}`,
                        content: { text: `prompt ${position.toString()}`, type: "text" },
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                });
            }
            await vi.runAllTimersAsync();

            const page = store.page(recordedTarget, 200, null);
            expect(page.events).toHaveLength(200);
            expect(page.events[0]).toMatchObject({ payload: { messageId: "command-101" } });
            expect(page.events.at(-1)).toMatchObject({ payload: { messageId: "command-300" } });
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given projected history spanning cache tiers, When newer events arrive between pages, Then the event-ID cursor resumes before the same event", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-cursor-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite"))),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
        try {
            for (let eventNumber = 1; eventNumber <= 300; eventNumber += 1) {
                store.append(recordedTarget, {
                    payload: {
                        messageId: `command-${eventNumber.toString()}`,
                        content: { text: `prompt ${eventNumber.toString()}`, type: "text" },
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                });
            }
            await vi.runAllTimersAsync();

            const newest = store.page(recordedTarget, 150, null);
            expect(newest.events[0]).toMatchObject({ payload: { messageId: "command-151" } });
            expect(newest.nextCursor).toBe(newest.events[0]?.eventId);

            store.append(recordedTarget, {
                payload: {
                    messageId: "command-301",
                    content: { text: "newer prompt", type: "text" },
                    sessionUpdate: "user_message_chunk",
                },
                type: "acp",
            });

            const older = store.page(recordedTarget, 150, newest.nextCursor);
            expect(older.events).toHaveLength(150);
            expect(older.events[0]).toMatchObject({ payload: { messageId: "command-1" } });
            expect(older.events.at(-1)).toMatchObject({ payload: { messageId: "command-150" } });
            expect(older.nextCursor).toBeNull();
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given V2 Session events cached by one process, When a new process opens the cache, Then stale V2 events are unavailable under a new Session generation", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-session-event-cache-"));
        const databasePath = join(temporaryDirectory, "events.sqlite");
        const sessionDatabasePath = join(temporaryDirectory, "sessions.sqlite");
        const firstSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const first = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databasePath)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(firstSessionDatabase)),
        );
        let firstGeneration = "";
        try {
            const requested = first.append(recordedTarget, {
                payload: {
                    commandId: "command-1",
                    content: [{ text: "cached prompt", type: "text" }],
                    kind: "prompt.requested",
                },
                type: "lifecycle-metadata",
            });
            first.append(recordedTarget, {
                payload: {
                    content: { text: "cached prompt", type: "text" },
                    messageId: requested.eventId,
                    sessionUpdate: "user_message_chunk",
                },
                type: "acp",
            });
            first.append(recordedTarget, {
                payload: {
                    content: { text: "cached update", type: "text" },
                    messageId: "message-1",
                    sessionUpdate: "user_message_chunk",
                },
                type: "acp",
            });
            const page = first.page(recordedTarget, 10, null);
            firstGeneration = page.sessionGenerationId;
            expect(
                page.events.map(
                    ({
                        eventId: _eventId,
                        recordedAt: _recordedAt,
                        sessionGenerationId: _generation,
                        target: _target,
                        ...event
                    }) => event,
                ),
            ).toEqual([
                {
                    payload: {
                        commandId: "command-1",
                        content: [{ text: "cached prompt", type: "text" }],
                        kind: "prompt.requested",
                    },
                    type: "lifecycle-metadata",
                },
                {
                    payload: {
                        content: { text: "cached prompt", type: "text" },
                        messageId: requested.eventId,
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                },
                {
                    payload: {
                        content: { text: "cached update", type: "text" },
                        messageId: "message-1",
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                },
            ]);
        } finally {
            first.close();
            firstSessionDatabase.close();
        }

        const secondSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const second = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databasePath)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(secondSessionDatabase)),
        );
        try {
            const page = second.page(recordedTarget, 10, null);
            expect(page.sessionGenerationId).not.toBe(firstGeneration);
            expect(page.events).toEqual([]);
        } finally {
            second.close();
            secondSessionDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an ACP Session database from the persisted-event release, When Morty opens it, Then the unused event table is removed", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-session-store-migration-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const legacyDatabase = new DatabaseSync(databasePath);
        try {
            for (const migration of acpSessionStoreMigrations.slice(0, -1)) {
                legacyDatabase.exec(migration.sql);
            }
            legacyDatabase.exec(`PRAGMA user_version = ${acpSessionStoreMigrations.length - 1}`);
        } finally {
            legacyDatabase.close();
        }

        const store = new SqliteSessionStore(
            new AcpSessionTable(openAcpSessionDatabase(databasePath)),
            new MemorySessionEventStore(),
        );
        store.close();
        const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
        try {
            expect(
                migratedDatabase
                    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_event_v2'")
                    .get(),
            ).toBeUndefined();
        } finally {
            migratedDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a managed Claude Code conversation, When the Computer restarts, Then its Session remains discoverable", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-session-store-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "claude",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                        environment: options.environment,
                    },
                    options,
                ),
            "claude",
            "Claude Code",
            process.execPath,
        );
        const signal = new AbortController().signal;
        const firstStore = new SqliteSessionStore(
            new AcpSessionTable(openAcpSessionDatabase(databasePath)),
            new MemorySessionEventStore(),
        );
        const firstRuntime = new SessionManager({
            observer: new NullSessionObserver(),
            store: firstStore,
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
        const sessionTarget = await firstRuntime.createNativeSession({
            agent,
            cwd: process.cwd(),
            signal,
        });

        try {
            await firstRuntime.runPrompt({
                agent,
                commandId: "claude-first-turn",
                cwd: process.cwd(),
                images: [],
                prompt: "Remember this conversation",
                resources: [],
                target: sessionTarget,
                signal,
            });
        } finally {
            await firstRuntime.close();
            firstStore.close();
        }

        const restartedStore = new SqliteSessionStore(
            new AcpSessionTable(openAcpSessionDatabase(databasePath)),
            new MemorySessionEventStore(),
        );
        const restartedRuntime = new SessionManager({
            observer: new NullSessionObserver(),
            store: restartedStore,
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
        try {
            expect(restartedRuntime.findSessions([sessionTarget])).toEqual([
                expect.objectContaining({ harness: "claude", prompted: true, target: sessionTarget }),
            ]);
        } finally {
            await restartedRuntime.close();
            restartedStore.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.skipIf(process.platform === "win32")(
        "Given an ACP Turn keeps running, When it is cancelled, Then Morty keeps its Agent process for the next Turn",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-long-turn-"));
            const adapterPath = join(temporaryDirectory, "pi-acp");
            const piPidPath = join(temporaryDirectory, "pi.pid");
            await writeFile(
                adapterPath,
                `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const pidPath = process.env.MORTY_TEST_PI_PID_FILE;
if (pidPath === undefined) process.exit(81);
const child = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Pi"], {
  env: process.env,
  stdio: "inherit",
});
if (child.pid === undefined) process.exit(82);
writeFileSync(pidPath, child.pid.toString());
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", () => process.exit(83));
child.once("exit", (code) => process.exit(code ?? 84));
`,
                { mode: 0o700 },
            );
            await chmod(adapterPath, 0o700);
            vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
            vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
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
            const adapterIdentity = readExecutableIdentity(adapterPath);
            const agent = createControlledAgent(
                (options) =>
                    new ControlledAcpConnection(
                        {
                            harness: "pi",
                            adapterPath: adapterIdentity.realPath,
                            arguments: [],
                            environment: options.environment,
                        },
                        options,
                    ),
                "pi",
                "Pi",
                process.execPath,
                { MORTY_TEST_PI_PID_FILE: piPidPath },
                "0.85.0",
            );

            try {
                const target = await manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                });
                const hangingTurn = manager.runPrompt({
                    agent,
                    commandId: "pi-hanging-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "hold after first delta",
                    resources: [],
                    target,
                    signal: new AbortController().signal,
                });
                let settled = false;
                void hangingTurn.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    },
                );
                await observer.waitForEvent(
                    (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                );

                await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);

                const piPid = Number.parseInt(await readFile(piPidPath, "utf8"), 10);
                expect(Number.isSafeInteger(piPid)).toBe(true);
                expect(settled).toBe(false);
                expect(processExists(piPid)).toBe(true);

                await manager.cancelPrompt(target, "pi-hanging-command");

                await expect(hangingTurn).resolves.toEqual({ stopReason: "cancelled" });
                expect(processExists(piPid)).toBe(true);
                observer.events.length = 0;
                await manager.runPrompt({
                    agent,
                    commandId: "pi-after-cancellation",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "continue in the retained process",
                    resources: [],
                    target,
                    signal: new AbortController().signal,
                });
                expect(observer.agentText()).toBe("Pi turn 2: continue in the retained process");
                expect(processExists(piPid)).toBe(true);
            } finally {
                vi.useRealTimers();
                await manager.close();
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it("Given a harness owns an empty conversation, When another harness is selected, Then the new harness creates its own conversation", async () => {
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
        const codex = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Codex"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
        );
        const claude = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "claude",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                        environment: options.environment,
                    },
                    options,
                ),
            "claude",
            "Claude Code",
            process.execPath,
        );

        try {
            await manager.createNativeSession({
                agent: codex,
                cwd: process.cwd(),
                signal: new AbortController().signal,
            });
            const selected = await manager.createNativeSession({
                agent: claude,
                cwd: process.cwd(),
                signal: AbortSignal.timeout(10_000),
            });

            await manager.runPrompt({
                agent: claude,
                commandId: "command-after-rebind",
                cwd: process.cwd(),
                images: [],
                prompt: "selected agent",
                resources: [],
                target: selected,
                signal: new AbortController().signal,
            });
            expect(observer.agentText()).toBe("Claude Code turn 1: selected agent");
        } finally {
            await manager.close();
        }
    });

    it("Given Controlled ACP emits untagged messages before a tool call, When they arrive, Then each update is recorded live without waiting for the tool boundary", async () => {
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
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Controlled ACP"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );

        try {
            await manager.runPrompt({
                agent,
                commandId: "controlled-acp-interleaved-command",
                cwd: process.cwd(),
                images: [],
                prompt: "interleave untagged progress",
                resources: [],
                target: await manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });
        } finally {
            await manager.close();
        }

        expect(
            observer
                .acpUpdates()
                .map((update) =>
                    (update.sessionUpdate === "agent_message_chunk" ||
                        update.sessionUpdate === "agent_thought_chunk") &&
                    update.content.type === "text"
                        ? { messageId: update.messageId ?? "", text: update.content.text }
                        : null,
                )
                .filter((entry): entry is { messageId: string; text: string } => entry !== null),
        ).toEqual([
            { messageId: "progress-1", text: "Gathering context" },
            { messageId: "reasoning-1", text: "Inspecting " },
            { messageId: "reasoning-1", text: "the workspace" },
            { messageId: "intermediate-1-1", text: "Checking the workspace" },
            { messageId: "intermediate-1-2", text: "Preparing the next tool call" },
            { messageId: "assistant-1", text: "Controlled ACP turn 1: " },
            { messageId: "assistant-1", text: "interleave untagged progress" },
        ]);
        expect(observer.toolUpdates("tool-1").at(0)).toMatchObject({
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "Read package metadata",
        });
        expect(observer.toolUpdates("tool-1").at(-1)).toMatchObject({
            sessionUpdate: "tool_call_update",
            status: "completed",
            rawOutput: { name: "morty-workspace" },
        });
    });

    it("Given the least recently used conversation has an active turn, When an eleventh conversation starts, Then the active process is retained and the oldest idle process is released", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-active-process-lru-"));
        const store = new MemorySessionStore();
        // The scenario exercises retirement at the boundary, so it pins the
        // retained process budget instead of inheriting the production default.
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
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
            maxProcesses: 10,
        });
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Codex", "--exclusive-writer"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
            { MORTY_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
        );
        const signal = new AbortController().signal;
        const activeTarget = await manager.createNativeSession({
            agent,
            cwd: temporaryDirectory,
            signal,
        });
        const activeTurn = manager.runPrompt({
            agent,
            commandId: "conversation-1-active",
            cwd: temporaryDirectory,
            images: [],
            prompt: "wait until cancelled",
            resources: [],
            target: activeTarget,
            signal,
        });
        const activityStarted = observer.waitForEvent(() =>
            observer.events.some(
                ({ event }) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
            ),
        );
        const runTurn = async (): Promise<NativeSessionTarget> => {
            const sessionTarget = await manager.createNativeSession({
                agent,
                cwd: temporaryDirectory,
                signal,
            });
            await manager.runPrompt({
                agent,
                commandId: crypto.randomUUID(),
                cwd: temporaryDirectory,
                images: [],
                prompt: "first",
                resources: [],
                target: sessionTarget,
                signal,
            });
            return sessionTarget;
        };
        const writerName = (sessionTarget: NativeSessionTarget): string => {
            const stored = store.read(sessionTarget);
            if (stored === undefined) {
                throw new Error(`Expected ${sessionTarget} to have a persisted native session`);
            }
            return `${encodeURIComponent(stored.sessionId)}.writer`;
        };

        try {
            await activityStarted;
            const idleTargets: NativeSessionTarget[] = [];
            for (let index = 2; index <= 10; index += 1) {
                idleTargets.push(await runTurn());
            }
            const activeWriter = writerName(activeTarget);
            const oldest = idleTargets[0];
            if (oldest === undefined) {
                throw new Error("Expected the oldest idle conversation");
            }
            const oldestIdleWriter = writerName(oldest);

            await runTurn();

            const activeWriters = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".writer"));
            expect(activeWriters).toHaveLength(10);
            expect(activeWriters).toContain(activeWriter);
            expect(activeWriters).not.toContain(oldestIdleWriter);
            await manager.cancelPrompt(activeTarget, "conversation-1-active");
            await expect(activeTurn).resolves.toEqual({ stopReason: "cancelled" });
        } finally {
            await manager.cancelPrompt(activeTarget, "conversation-1-active");
            await activeTurn.catch(() => undefined);
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an ACP agent announces a different session while creating one, When Morty receives the created session, Then the local boundary rejects the queued update", async () => {
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
                        arguments: [
                            fakeAgentPath,
                            "--agent-name",
                            "Controlled ACP",
                            "--announce-config-while-creating",
                            "--announce-wrong-session-while-creating",
                        ],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );

        try {
            await expect(
                manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "invalid_agent_session" });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent returns the standard authentication error, When Morty starts its session, Then the local boundary preserves an authentication-required code", async () => {
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
                        arguments: [fakeAgentPath, "--authentication-required"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );

        try {
            await expect(
                manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "authentication_required" });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent rejects a prompt with a non-authentication error, When Morty runs that turn, Then the local boundary preserves the agent's real failure reason", async () => {
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
                        arguments: [fakeAgentPath, "--agent-name", "Controlled ACP"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );

        try {
            await expect(
                manager.runPrompt({
                    agent,
                    commandId: "command-model-unavailable",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "fail with model unavailable",
                    resources: [],
                    target: await manager.createNativeSession({
                        agent,
                        cwd: process.cwd(),
                        signal: AbortSignal.timeout(10_000),
                    }),
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({
                code: "acp_agent_error",
                message: "Internal error: Model unavailable: controlled/test-model",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given Codex includes an invalid-prompt detail in an internal ACP error, When Morty runs that turn, Then the user receives the actionable detail", async () => {
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
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Codex"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
        );

        try {
            await expect(
                manager.runPrompt({
                    agent,
                    commandId: "command-invalid-prompt",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "fail with invalid prompt detail",
                    resources: [],
                    target: await manager.createNativeSession({
                        agent,
                        cwd: process.cwd(),
                        signal: AbortSignal.timeout(10_000),
                    }),
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({
                code: "acp_agent_error",
                message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP Agent has a tool subprocess, When the turn is cancelled, Then Morty retains the process tree until Computer shutdown", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-acp-cancel-tree-"));
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
        const adapterPath = join(temporaryDirectory, "codex-acp.mjs");
        const childPidPath = join(temporaryDirectory, "tool-child.pid");
        await writeFile(
            adapterPath,
            `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const childPidPath = process.env.MORTY_TEST_CHILD_PID_FILE;
if (childPidPath === undefined) process.exit(81);
const tool = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], {
  detached: true,
  windowsHide: true,
  env: process.env,
  stdio: "ignore",
});
if (tool.pid === undefined) process.exit(82);
writeFileSync(childPidPath, tool.pid.toString());
const agent = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Codex"], {
  env: process.env,
  stdio: "inherit",
});
agent.once("error", () => process.exit(83));
agent.once("exit", (code) => process.exit(code ?? 84));
`,
            { mode: 0o700 },
        );
        await chmod(adapterPath, 0o700);
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [adapterPath],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory,
                MORTY_TEST_CHILD_PID_FILE: childPidPath,
            },
        );
        let childPid = 0;

        try {
            const target = await manager.createNativeSession({
                agent,
                cwd: temporaryDirectory,
                signal: AbortSignal.timeout(10_000),
            });
            const cancelledTurn = manager.runPrompt({
                agent,
                commandId: "command-cancelled-tree",
                cwd: temporaryDirectory,
                images: [],
                prompt: "wait until cancelled",
                resources: [],
                target,
                signal: new AbortController().signal,
            });
            await observer.turnStarted();
            childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
            expect(Number.isSafeInteger(childPid)).toBe(true);

            await manager.cancelPrompt(target, "command-cancelled-tree");

            await expect(cancelledTurn).resolves.toEqual({
                stopReason: "cancelled",
            });
            expect(processExists(childPid)).toBe(true);
            observer.events.length = 0;
            await manager.runPrompt({
                agent,
                commandId: "command-after-tree-cancel",
                cwd: temporaryDirectory,
                images: [],
                prompt: "continue",
                resources: [],
                target,
                signal: new AbortController().signal,
            });
            expect(observer.agentText()).toBe("Codex turn 2: continue");
            expect(processExists(childPid)).toBe(true);
            await manager.close();
            expect(processExists(childPid)).toBe(false);
        } finally {
            await manager.close();
            if (childPid > 0 && processExists(childPid)) {
                try {
                    process.kill(process.platform === "win32" ? childPid : -childPid, "SIGKILL");
                } catch {
                    // A concurrently exited test process no longer needs cleanup.
                }
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an ACP subprocess exits during shutdown, When its session manager closes, Then the stream failure is contained", async () => {
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
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--exit-after-session-creation"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
        );
        const signal = new AbortController().signal;

        const target = await manager.createNativeSession({
            agent,
            cwd: process.cwd(),
            signal,
        });
        await expect(
            manager.applySessionConfiguration({
                agent,
                configId: "model",
                cwd: process.cwd(),
                requestId: "configure-exited-session",
                target,
                signal,
                value: "test-large",
                type: "select",
            }),
        ).rejects.toThrow();

        await expect(manager.close()).resolves.toBeUndefined();
    });

    it("Given an ACP process pipe fails, When the protocol writes to it, Then the stream reports the failure without an uncaught process error", async () => {
        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
            },
        });
        const writer = createWritableAcpStream(output).getWriter();

        await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("broken pipe");
    });
});
