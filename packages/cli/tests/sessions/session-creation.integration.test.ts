import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgent } from "./acp-feature-fixture.ts";

it("Given a Session's creation is cancelled while its settings are applied, When the Runtime lists its Sessions, Then the half-configured Session is not held and a new creation succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-session-creation-"));
    const manager = new SessionManager({
        observer: {},
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
        const agent = fakeAgent([], { MORTY_FAKE_ACP_STATE_DIRECTORY: directory });
        const cancellation = new AbortController();
        await expect(
            manager.createConfiguredSession(
                { agent, cwd: directory, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]) },
                async (_created, signal) => {
                    cancellation.abort(new Error("The client went away."));
                    signal.throwIfAborted();
                },
            ),
        ).rejects.toThrow("The client went away.");
        expect(manager.listSessions(10)).toEqual([]);

        const created = await manager.createConfiguredSession(
            { agent, cwd: directory, signal: AbortSignal.timeout(10_000) },
            async () => undefined,
        );
        expect(manager.listSessions(10).map((session) => session.target)).toEqual([created.target]);
    } finally {
        await manager.close();
        await rm(directory, { recursive: true, force: true });
    }
});
