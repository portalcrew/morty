import { describe, expect, it } from "vitest";

import { fixture } from "./native-session-fixture.ts";

describe("native session identity", () => {
    it("Given a native conversation was imported with its raw V2 events, When it is imported again, Then the canonical target reopens with the Agent-owned history unchanged", async () => {
        const f = await fixture("Claude Code");
        const signal = new AbortController().signal;
        try {
            await f.seed("Canonical V2 import");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const first = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    sessionId: entry.sessionId,
                },
                signal,
            );
            if (first.action !== "import") {
                throw new Error("Expected a native import");
            }
            const initial = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    target: first.target,
                    signal,
                },
                10_000,
                null,
            );

            const repeated = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    sessionId: entry.sessionId,
                    requestId: "repeated-v2-import",
                },
                signal,
            );

            expect(repeated).toMatchObject({
                action: "import",
                target: first.target,
            });
            await expect(
                f.sessions.loadSessionEvents(
                    {
                        agent: f.agent,
                        cwd: f.workspace,
                        target: first.target,
                        signal,
                    },
                    10_000,
                    null,
                ),
            ).resolves.toEqual(initial);
        } finally {
            await f.close();
        }
    });

    it.each(["import", "fork"] as const)(
        "Given a native conversation has raw ACP replay records, When Chat requests %s, Then the target replays the Agent-owned updates in order",
        async (action) => {
            const f = await fixture("Claude Code");
            const signal = new AbortController().signal;
            try {
                await f.seed("V2 source context");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                const source = await f.sessions.previewNativeSessionEvents(
                    {
                        agent: f.agent,
                        cwd: f.workspace,
                        signal,
                    },
                    entry.sessionId,
                    10_000,
                    null,
                );

                const result = await f.service.execute({ ...f.identity, action, sessionId: entry.sessionId }, signal);
                if (result.action !== action) {
                    throw new Error("Expected a native open result");
                }
                const replayed = await f.sessions.loadSessionEvents(
                    {
                        agent: f.agent,
                        cwd: f.workspace,
                        target: result.target,
                        signal,
                    },
                    10_000,
                    null,
                );

                expect(replayed.events.map(({ payload }) => payload)).toEqual(
                    source.events.map(({ payload }) => payload),
                );
            } finally {
                await f.close();
            }
        },
    );

    it("Given an imported native conversation that was archived, When it is imported again, Then the same Session is held again", async () => {
        const f = await fixture("Claude Code", "supported");
        const signal = new AbortController().signal;
        try {
            await f.seed("Reopen by importing");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const first = await f.service.execute(
                { ...f.identity, action: "import", sessionId: entry.sessionId },
                signal,
            );
            if (first.action !== "import") {
                throw new Error("Expected a native import");
            }
            await f.sessions.archiveSession(first.target, signal);

            const repeated = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    sessionId: entry.sessionId,
                    requestId: "import-after-archive",
                },
                signal,
            );

            expect(repeated).toMatchObject({ action: "import", target: first.target });
        } finally {
            await f.close();
        }
    });

    it("Given an imported native conversation is running a turn, When another device imports it again, Then the running Session is returned and its turn continues", async () => {
        const f = await fixture("Claude Code", "supported");
        const signal = new AbortController().signal;
        try {
            await f.seed("Join while it works");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const first = await f.service.execute(
                { ...f.identity, action: "import", sessionId: entry.sessionId },
                signal,
            );
            if (first.action !== "import") {
                throw new Error("Expected a native import");
            }
            const turnCancellation = new AbortController();
            const turn = f.sessions.runPrompt({
                agent: f.agent,
                cwd: f.workspace,
                target: first.target,
                commandId: crypto.randomUUID(),
                prompt: "interleave progress and hold",
                images: [],
                resources: [],
                signal: turnCancellation.signal,
            });
            let turnSettled = false;
            void turn.then(
                () => {
                    turnSettled = true;
                },
                () => {
                    turnSettled = true;
                },
            );
            await f.observer.nextUpdate(
                (update) =>
                    update.sessionUpdate === "agent_message_chunk" &&
                    update.content.type === "text" &&
                    update.content.text === "Checking the workspace",
            );

            const joined = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    sessionId: entry.sessionId,
                    requestId: "import-while-running",
                },
                signal,
            );

            expect(joined).toMatchObject({ action: "import", target: first.target });
            expect(turnSettled).toBe(false);
            turnCancellation.abort();
            await expect(turn).rejects.toBeDefined();
        } finally {
            await f.close();
        }
    });

    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given a %s returns its harness-owned native pair, When the Computer restarts, Then that conversation remains discoverable and can continue",
        async (action) => {
            const f = await fixture("Claude Code", "supported");
            try {
                await f.seed("Original context");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native session");
                }
                const opened = await f.service.execute(
                    { ...f.identity, action, sessionId: entry.sessionId },
                    new AbortController().signal,
                );
                if (opened.action !== action) {
                    throw new Error("Expected a native open result");
                }
                await f.restart();
                expect(await f.service.querySessions([opened.target], new AbortController().signal)).toMatchObject([
                    { target: opened.target },
                ]);
                const reply = await f.sessions.runPrompt({
                    agent: f.agent,
                    cwd: f.workspace,
                    target: opened.target,
                    commandId: crypto.randomUUID(),
                    prompt: "Continue original context",
                    images: [],
                    resources: [],
                    signal: new AbortController().signal,
                });
                expect(reply.stopReason).toBe("end_turn");
                expect((await f.list()).entries).toHaveLength(action === "fork" ? 2 : 1);
            } finally {
                await f.close();
            }
        },
    );

    it.each(["Claude Code", "Pi"] as const)(
        "Given a new %s chat, When the Computer restarts, Then its native ID resumes the saved thread and history",
        async (agentName) => {
            const f = await fixture(agentName, "supported");
            const signal = new AbortController().signal;
            const target = await f.sessions.createNativeSession({
                agent: f.agent,
                cwd: f.workspace,
                signal,
            });
            await f.restart();
            const restarted = f.sessions;
            try {
                await restarted.runPrompt({
                    agent: f.agent,
                    cwd: f.workspace,
                    signal,
                    target,
                    commandId: crypto.randomUUID(),
                    prompt: "Continue this chat",
                    lifecycle: {
                        attemptId: crypto.randomUUID(),
                        content: [{ type: "text", text: "Continue this chat" }],
                        dispatch: { kind: "own" },
                    },
                    images: [],
                    resources: [],
                });
                const replay = await restarted.loadSessionEvents(
                    {
                        agent: f.agent,
                        cwd: f.workspace,
                        signal,
                        target,
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
                ).toContain("Continue this chat");
            } finally {
                await restarted.close();
                await f.close();
            }
        },
    );

    it("Given Chat forks a native conversation, When a post-fork turn completes and Chat reloads, Then Computer history contains that turn", async () => {
        const f = await fixture("Claude Code");
        const signal = new AbortController().signal;
        try {
            await f.seed("Fork source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const opened = await f.service.execute(
                {
                    ...f.identity,
                    action: "fork",
                    sessionId: entry.sessionId,
                },
                signal,
            );
            if (opened.action !== "fork") {
                throw new Error("Expected a native fork");
            }
            await f.sessions.runPrompt({
                agent: f.agent,
                cwd: f.workspace,
                signal,
                target: opened.target,
                commandId: crypto.randomUUID(),
                prompt: "Post-fork turn",
                lifecycle: {
                    attemptId: crypto.randomUUID(),
                    content: [{ type: "text", text: "Post-fork turn" }],
                    dispatch: { kind: "own" },
                },
                images: [],
                resources: [],
            });

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    cwd: f.workspace,
                    signal,
                    target: opened.target,
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
            ).toContain("Post-fork turn");
        } finally {
            await f.close();
        }
    });

    it("Given an Agent returns the original session as a fork, When a user requests an independent conversation, Then the invalid fork is rejected", async () => {
        const f = await fixture("Claude Code", "invalid-fork");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "fork",
                        sessionId: entry.sessionId,
                    },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "invalid_native_session_response" });
            expect((await f.list()).entries.map((session) => session.title)).toEqual(["Original context"]);
        } finally {
            await f.close();
        }
    });
});
