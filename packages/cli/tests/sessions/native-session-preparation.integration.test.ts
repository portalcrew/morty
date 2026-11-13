import { existsSync, watch } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSessionCommand } from "@morty-build/client/protocol";
import { describe, expect, it, vi } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { NullSessionObserver } from "../../src/engine/session/api/session-api.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

import { fixture } from "./native-session-fixture.ts";

describe("native session preparation", () => {
    it("Given shared preparation is loading, When one waiter cancels, Then it fails without cancelling the owner", async () => {
        const f = await fixture("Claude Code", "load-only");
        const owner = new AbortController();
        try {
            const sessionId = await f.seed("Shared preparation");
            await writeFile(join(f.native, "pause-load"), "");
            const options = {
                agent: f.agent,
                cwd: f.workspace,
                target: { harness: f.agent.harness, sessionId },
                signal: owner.signal,
            } as const;
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const preparing = f.sessions.openNativeSession(options, { kind: "import", sessionId, title: "" });
            await paused.promise;
            const waiter = new AbortController();
            const cancelled = f.sessions.prepareSession({ ...options, signal: waiter.signal }).then(
                () => "completed",
                () => "cancelled",
            );
            waiter.abort();
            await rm(join(f.native, "pause-load"));
            await preparing;
            expect(await cancelled).toBe("cancelled");
        } finally {
            owner.abort();
            await f.close();
        }
    });

    it("Given preparation is still loading, When the Computer closes, Then preparation cannot return a live conversation", async () => {
        const f = await fixture("Claude Code", "load-only");
        const owner = new AbortController();
        try {
            const sessionId = await f.seed("Closing preparation");
            await writeFile(join(f.native, "pause-load"), "");
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const preparing = f.sessions
                .openNativeSession(
                    {
                        agent: f.agent,
                        cwd: f.workspace,
                        signal: owner.signal,
                    },
                    { kind: "import", sessionId, title: "" },
                )
                .then(
                    () => "completed",
                    () => "cancelled",
                );
            await paused.promise;
            await f.sessions.close();
            await rm(join(f.native, "pause-load"), { force: true });
            expect(await preparing).toBe("cancelled");
        } finally {
            owner.abort();
            await f.close();
        }
    });

    it("Given a saved ACP conversation is open elsewhere, When a user imports it and retries after it closes, Then the original opening error is reported and the retry opens the conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
        const f = await fixture("Claude Code", "exclusive-writer");
        const external = new SessionManager({
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
        try {
            await external.runPrompt({
                agent: f.agent,
                cwd: f.workspace,
                signal: new AbortController().signal,
                target: await external.createNativeSession({
                    agent: f.agent,
                    cwd: f.workspace,
                    signal: AbortSignal.timeout(10_000),
                }),
                commandId: "external-turn",
                prompt: "Saved conversation",
                images: [],
                resources: [],
            });
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const command = {
                ...f.identity,
                action: "import",
                sessionId: entry.sessionId,
            } satisfies NativeSessionCommand;
            await expect(f.service.execute(command, new AbortController().signal)).rejects.toMatchObject({
                code: "acp_agent_error",
            });
            await external.close();
            expect(await f.service.execute(command, new AbortController().signal)).toMatchObject({
                action: "import",
                target: { harness: f.agent.harness, sessionId: entry.sessionId },
            });
        } finally {
            await external.close();
            await f.close();
            vi.useRealTimers();
        }
    });

    it("Given an Agent returns a detailed internal ACP error, When a user imports its native session, Then the actionable detail is reported", async () => {
        const f = await fixture("Codex", "load-only");
        try {
            const sessionId = await f.seed("Unavailable native history");
            const entry = (await f.list()).entries.find((candidate) => candidate.sessionId === sessionId);
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            process.env["MORTY_FAKE_ACP_FAIL_HISTORY_LOAD"] = "1";
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "import",
                        sessionId: entry.sessionId,
                    },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({
                code: "acp_agent_error",
                message: "Native history unavailable in the current working directory",
            });
        } finally {
            delete process.env["MORTY_FAKE_ACP_FAIL_HISTORY_LOAD"];
            await f.close();
        }
    });
});
