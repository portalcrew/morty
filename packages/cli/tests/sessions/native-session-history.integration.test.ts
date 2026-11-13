import { existsSync, watch } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sameNativeSession } from "@morty-build/client/native-session";
import { describe, expect, it, vi } from "vitest";
import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import { MemorySessionEventStore } from "../../src/engine/session/history/session-event-store.ts";
import { ControlledAcpAdapter } from "../support/controlled-acp-adapter.ts";
import { fixture } from "./native-session-fixture.ts";

/** A direct-read adapter with canned history, standing in for the Codex app-server. */
const cannedHistoryAdapter: AdapterResolver = (agent, dependencies) => {
    const acp = new ControlledAcpAdapter(agent, dependencies);
    const events = new MemorySessionEventStore();
    return {
        refreshAgent: acp.refreshAgent,
        getCapabilities: acp.getCapabilities,
        releaseSession: acp.releaseSession,
        readNativeHistoryRevision: acp.readNativeHistoryRevision,
        createSession: acp.createSession,
        forkSession: acp.forkSession,
        openSession: acp.openSession,
        openSessionWithReplay: acp.openSessionWithReplay,
        cancel: acp.cancel,
        closeSession: acp.closeSession,
        prompt: acp.prompt,
        steer: acp.steer,
        renameSession: acp.renameSession,
        configureSession: acp.configureSession,
        listSessions: acp.listSessions,
        findSession: acp.findSession,
        close: async () => {
            await acp.close();
            events.close();
        },
        readSessionHistory: async ({ request }) => {
            const target = { harness: agent.harness, sessionId: request.sessionId };
            events.materialize(target, request.sessionId, [
                {
                    type: "acp",
                    payload: {
                        sessionUpdate: "user_message_chunk",
                        messageId: "user",
                        content: { type: "text", text: "Read without resuming" },
                    },
                },
                {
                    type: "acp",
                    payload: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "assistant",
                        content: { type: "text", text: "Preview available" },
                    },
                },
            ]);
            return events.page(target, request.eventLimit, request.cursor);
        },
    };
};

describe("native session history", () => {
    it("Given a saved session requests permission and input during preview, When its history is read, Then both interactions are rejected without publishing live events", async () => {
        const f = await fixture("Claude Code", "load-only");
        try {
            const sessionId = await f.seed("Preview requiring interaction");
            await writeFile(join(f.native, "interactions-during-preview"), "");
            const preview = await f.sessions.previewNativeSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: new AbortController().signal,
                },
                sessionId,
                50,
                null,
            );
            const messages = preview.events.flatMap((event) =>
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
                    ? [event.payload.content.text]
                    : [],
            );
            expect(messages.join("").match(/Preview interaction rejected/g)).toHaveLength(2);
            expect(f.observer.updates).toEqual([]);
        } finally {
            await f.close();
        }
    });
    it("Given Codex already owns a native session writer, When Chat previews that session, Then Computer reads history without requesting another writer", async () => {
        const f = await fixture("Codex", "exclusive-writer", cannedHistoryAdapter);
        const signal = new AbortController().signal;
        try {
            const sessionId = await f.seed("Writer-owned Codex session");
            await f.sessions.openNativeSession(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal,
                },
                { kind: "import", sessionId, title: "Writer-owned Codex session" },
            );

            const preview = await f.sessions.previewNativeSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal,
                },
                sessionId,
                50,
                null,
            );

            expect(
                preview.events.flatMap((event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toEqual(["Read without resuming", "Preview available"]);
        } finally {
            await f.close();
        }
    });

    it("Given Chat imports a titled Codex conversation, When the imported Chat opens, Then its source title and history remain visible without requesting another writer", async () => {
        const f = await fixture("Codex", "exclusive-writer");
        const signal = new AbortController().signal;
        try {
            await f.seed("Writer-owned Codex session");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const opened = await f.service.execute(
                { ...f.identity, action: "import", sessionId: entry.sessionId },
                signal,
            );
            if (opened.action !== "import") {
                throw new Error("Expected native import");
            }

            expect(
                f.sessions.listSessions(10).find((session) => sameNativeSession(session.target, opened.target))?.title,
            ).toBe(entry.title);

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    target: opened.target,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toEqual(["Writer-owned Codex session", "Codex turn 1: Writer-owned Codex session"]);
        } finally {
            await f.close();
        }
    });

    it("Given Chat imports a Claude Code conversation, When the imported Chat opens, Then its source history is visible", async () => {
        const f = await fixture("Claude Code", "exclusive-writer");
        const signal = new AbortController().signal;
        try {
            await f.seed("Imported Claude source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const opened = await f.service.execute(
                { ...f.identity, action: "import", sessionId: entry.sessionId },
                signal,
            );
            if (opened.action !== "import") {
                throw new Error("Expected native import");
            }

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    target: opened.target,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Imported Claude source");
        } finally {
            await f.close();
        }
    });

    it("Given Chat forks a Claude Code conversation, When the forked Chat opens, Then its copied history is visible", async () => {
        const f = await fixture("Claude Code", "exclusive-writer");
        const signal = new AbortController().signal;
        try {
            await f.seed("Forked Claude source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const opened = await f.service.execute(
                { ...f.identity, action: "fork", sessionId: entry.sessionId },
                signal,
            );
            if (opened.action !== "fork") {
                throw new Error("Expected native fork");
            }

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    target: opened.target,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Forked Claude source");
        } finally {
            await f.close();
        }
    });

    it("Given ACP replays committed native updates, When Computer loads V2 source facts, Then every accepted notification is exposed once without V1 activity folding", async () => {
        const f = await fixture("Pi");
        try {
            const sessionId = await f.seed("Preserve this update");
            const replay = await f.sessions.previewNativeSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: new AbortController().signal,
                },
                sessionId,
                50,
                null,
            );

            const updates = replay.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            expect(updates).toMatchObject([
                {
                    content: { text: "Preserve this update", type: "text" },
                    messageId: "user-1",
                    sessionUpdate: "user_message_chunk",
                },
                {
                    content: { text: "Inspecting the workspace", type: "text" },
                    messageId: "reasoning-assistant-1",
                    sessionUpdate: "agent_thought_chunk",
                },
                {
                    sessionUpdate: "tool_call",
                    toolCallId: "tool-assistant-1",
                },
                {
                    sessionUpdate: "tool_call",
                    toolCallId: "error-assistant-1",
                },
                {
                    content: { text: "Pi turn 1: Preserve this update", type: "text" },
                    messageId: "assistant-1",
                    sessionUpdate: "agent_message_chunk",
                },
            ]);

            const newestMessage = await f.sessions.previewNativeSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: new AbortController().signal,
                },
                sessionId,
                4,
                null,
            );
            expect(newestMessage.nextCursor).not.toBeNull();
            expect(
                newestMessage.events.flatMap((event) => (event.type === "acp" ? [event.payload.sessionUpdate] : [])),
            ).toEqual(["agent_thought_chunk", "tool_call", "tool_call", "agent_message_chunk"]);
            const olderMessage = await f.sessions.previewNativeSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: new AbortController().signal,
                },
                sessionId,
                4,
                newestMessage.nextCursor,
            );
            expect(olderMessage.nextCursor).toBeNull();
            expect([...olderMessage.events, ...newestMessage.events].map(({ payload }) => payload)).toEqual(
                replay.events.map(({ payload }) => payload),
            );
        } finally {
            await f.close();
        }
    });

    it("Given Pi emits persisted history only on the first session load, When Chat requests history after preparation, Then Computer returns messages from that load", async () => {
        const f = await fixture("Pi", "replay-history-once");
        const signal = new AbortController().signal;
        try {
            await f.seed("Persisted Pi message");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing Pi conversation");
            }
            const opened = await f.service.execute(
                { ...f.identity, action: "import", sessionId: entry.sessionId },
                signal,
            );
            if (opened.action !== "import") {
                throw new Error("Expected native import");
            }

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    target: opened.target,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Persisted Pi message");
        } finally {
            await f.close();
        }
    });

    it("Given two clients request Pi history while its first session load is in progress, When that load completes, Then both clients receive the same history", async () => {
        const f = await fixture("Pi");
        const signal = new AbortController().signal;
        try {
            const sessionId = await f.seed("Shared Pi history");
            const opened = await f.sessions.openNativeSession(
                { agent: f.agent, cwd: f.workspace, signal },
                { kind: "import", sessionId: sessionId, title: "Shared Pi history" },
            );
            await writeFile(join(f.native, "pause-load"), "");
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const options = {
                agent: f.agent,
                cwd: f.workspace,
                target: opened.target,
                signal,
            };
            const first = f.sessions.loadSessionEvents(options, 50, null);
            await paused.promise;
            const second = f.sessions.loadSessionEvents(options, 50, null);
            await rm(join(f.native, "pause-load"));

            for (const replay of await Promise.all([first, second])) {
                expect(
                    replay.events.flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    ),
                ).toContain("Shared Pi history");
            }
        } finally {
            await rm(join(f.native, "pause-load"), { force: true });
            await f.close();
        }
    });

    it("Given a saved local conversation, When its history is previewed and then forked, Then only preview returns history and only fork creates a new conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
        const f = await fixture("Claude Code", "exclusive-writer");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const files = await readdir(f.native);
            const source = files.find((file) => file.endsWith(".json"));
            if (source === undefined) {
                throw new Error("Missing saved native conversation");
            }
            const original = await readFile(join(f.native, source), "utf8");
            const fork = await f.service.execute(
                {
                    ...f.identity,
                    action: "fork",
                    sessionId: entry.sessionId,
                },
                new AbortController().signal,
            );
            if (fork.action !== "fork") {
                throw new Error("Expected native fork");
            }
            expect(fork).toMatchObject({
                action: "fork",
                target: fork.target,
            });
            expect((await f.list()).entries).toHaveLength(2);
            expect(await readFile(join(f.native, source), "utf8")).toBe(original);
        } finally {
            await f.close();
            vi.useRealTimers();
        }
    });
    it("Given a titled local conversation, When it is forked repeatedly, Then each child receives the next numbered fork title", async () => {
        const f = await fixture("Claude Code");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }

            const first = await f.service.execute(
                { ...f.identity, action: "fork", sessionId: entry.sessionId, requestId: crypto.randomUUID() },
                new AbortController().signal,
            );
            const second = await f.service.execute(
                { ...f.identity, action: "fork", sessionId: entry.sessionId, requestId: crypto.randomUUID() },
                new AbortController().signal,
            );

            expect(first).toMatchObject({ action: "fork", title: "Original context (Fork #1)" });
            expect(second).toMatchObject({ action: "fork", title: "Original context (Fork #2)" });
            expect(f.sessions.listSessions(10).map((session) => session.title)).toEqual(
                expect.arrayContaining(["Original context (Fork #1)", "Original context (Fork #2)"]),
            );
        } finally {
            await f.close();
        }
    });
    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given native history loading is unavailable, When a saved conversation is %sed, Then Computer opens it without loading history",
        async (action) => {
            const f = await fixture("Claude Code");
            try {
                await f.seed("Private native history");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                await writeFile(join(f.native, "pause-load"), "");

                const result = await f.service.execute(
                    {
                        ...f.identity,
                        action,
                        sessionId: entry.sessionId,
                    },
                    new AbortController().signal,
                );
                if (result.action !== action) {
                    throw new Error("Expected native open result");
                }
                expect(result).toMatchObject({
                    action,
                    target: result.target,
                });
                expect("history" in result).toBe(false);
                expect(await readdir(f.native)).not.toContain("load-paused");
            } finally {
                await f.close();
            }
        },
    );
});
