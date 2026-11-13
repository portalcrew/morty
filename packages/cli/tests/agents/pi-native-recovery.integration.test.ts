import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

function piChildProcesses(): readonly number[] {
    return execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter(([, parent, command]) => Number(parent) === process.pid && command === "pi")
        .map(([pid]) => Number(pid));
}

test.each(["responsive", "stalled", "launcher-stalled"])(
    "Given a %s real Pi native Session, When the active prompt is cancelled with a follow-up queued, Then the queued prompt restores that Session and completes",
    async (state) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let holdResponse = false;
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "NATIVE_RECOVERY_REPLY", {
            beforeFirstText: async () => {
                if (holdResponse) {
                    entered.resolve();
                    await release.promise;
                }
            },
        });
        await using agent = await PiFixture.create(provider);
        const launcher = state === "launcher-stalled" ? await agent.createLauncher() : null;
        const environment =
            launcher === null ? agent.environment : { ...agent.environment, MORTY_PI_PATH: launcher.command };
        const stopped: number[] = [];
        try {
            await withRealDaemon(new PiAgentSpecification(), environment, async (peer) => {
                const nativeId = peer.target;
                const sendPrompt = (commandId: string): void =>
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            requestId: commandId,
                            commandId,
                            requestId: commandId,
                            target: nativeId,
                            attachments: [],
                            prompt: "Reply with a short greeting, without using tools",
                            disposition: SessionPromptDisposition.Append,
                        }),
                    );
                const finish = async (commandId: string, reason: string): Promise<string> => {
                    let text = "";
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.failed" &&
                            event.payload.commandId === commandId
                        ) {
                            throw new Error(JSON.stringify(event));
                        }
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            text += event.payload.content.text;
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId
                        ) {
                            expect(event.payload.commandId).toBe(commandId);
                            expect(event.target).toEqual(nativeId);
                            expect(event.payload.stopReason).toBe(reason);
                            return text;
                        }
                    }
                };
                const initial = randomUUID();
                sendPrompt(initial);
                expect(await finish(initial, "end_turn")).toContain("NATIVE_RECOVERY_REPLY");
                holdResponse = true;
                const active = randomUUID();
                sendPrompt(active);
                // Model output is held; the real Agent and daemon remain in control of cancellation.
                await new Promise<void>((resolve, reject) => {
                    const abort = (): void => reject(peer.signal.reason);
                    peer.signal.addEventListener("abort", abort, { once: true });
                    void entered.promise.then(() => {
                        peer.signal.removeEventListener("abort", abort);
                        resolve();
                    });
                });
                if (state !== "responsive") {
                    stopped.push(
                        ...(launcher === null
                            ? piChildProcesses()
                            : [Number(await readFile(launcher.pidFile, "utf8"))]),
                    );
                    expect(stopped).toHaveLength(1);
                    for (const pid of stopped) {
                        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
                        process.kill(pid, "SIGSTOP");
                    }
                }
                const queued = randomUUID();
                sendPrompt(queued);
                for (;;) {
                    const message = await peer.nextMessage();
                    if (
                        decodeMessageKind(message) === SESSION_EVENT_KIND &&
                        decodeSessionEventEnvelope(message).events.some(
                            (event) =>
                                event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                        )
                    ) {
                        break;
                    }
                }
                peer.send(
                    encodeSessionCancelCommand({
                        kind: "session.cancel",
                        requestId: crypto.randomUUID(),
                        commandId: active,
                        target: nativeId,
                    }),
                );
                await finish(active, "cancelled");
                holdResponse = false;
                release.resolve();
                expect(await finish(queued, "end_turn")).toContain("NATIVE_RECOVERY_REPLY");
                for (const pid of stopped) {
                    expect(() => process.kill(pid, 0)).toThrow();
                }
            });
        } finally {
            release.resolve();
            for (const pid of stopped) {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    // The daemon already retired the stalled process.
                }
            }
        }
    },
);

test("Given a real Pi native Session was previewed, When the user imports it, Then the daemon stays online and opens the Session", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_PREVIEW_IMPORT_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sourceSessionId = await prepareNewRealSession(peer, "pi");
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                requestId: commandId,
                commandId,
                requestId: commandId,
                target: sourceSessionId,
                attachments: [],
                prompt: "Reply with a short greeting, without using tools",
                disposition: SessionPromptDisposition.Append,
            }),
        );
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.failed" &&
                event.payload.commandId === commandId
            ) {
                throw new Error(JSON.stringify(event));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                break;
            }
        }

        const listRequestId = randomUUID();
        const identity = {
            harness: "pi",
            directory: ".",
        } as const;
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "list",
                cursor: null,
                kind: "native.session.request",
                requestId: listRequestId,
            }),
        );
        let entry: Extract<
            ReturnType<typeof decodeNativeSessionResult>,
            { readonly action: "list" }
        >["entries"][number];
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== listRequestId || result.action !== "list") {
                continue;
            }
            const source = result.entries.find((candidate) => candidate.sessionId === sourceSessionId.sessionId);
            if (source === undefined) {
                throw new Error("Missing source native Session");
            }
            entry = source;
            break;
        }

        const previewRequestId = randomUUID();
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                ...identity,
                cursor: null,
                eventLimit: 200,
                kind: "session.preview-history.page.load",
                requestId: previewRequestId,
                target: { harness: "pi", sessionId: entry.sessionId },
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.preview-history.page.loaded") {
                continue;
            }
            const preview = decodeSessionPreviewHistoryPageLoaded(message);
            if (preview.requestId === previewRequestId) {
                expect(preview.events.events.events.length).toBeGreaterThan(0);
                break;
            }
        }

        const importRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "import",
                sessionId: entry.sessionId,
                kind: "native.session.request",
                requestId: importRequestId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== importRequestId || result.action !== "import") {
                continue;
            }
            expect(result.target).toEqual(sourceSessionId);
            expect(result.ready.restored).toBe(true);
            break;
        }
    });
});

test("Given a saved real Pi native Session, When the user forks it, Then its history is visible before the independent Session continues", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_FORK_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sourceSessionId = await prepareNewRealSession(peer, "pi");
        const sourceCommandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                requestId: sourceCommandId,
                commandId: sourceCommandId,
                requestId: sourceCommandId,
                target: sourceSessionId,
                attachments: [],
                prompt: "Save this conversation so it can be forked",
                disposition: SessionPromptDisposition.Append,
            }),
        );
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === sourceCommandId
            ) {
                break;
            }
        }

        const listRequestId = randomUUID();
        const identity = {
            harness: "pi",
            directory: ".",
        } as const;
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "list",
                cursor: null,
                kind: "native.session.request",
                requestId: listRequestId,
            }),
        );
        let entry: Extract<
            ReturnType<typeof decodeNativeSessionResult>,
            { readonly action: "list" }
        >["entries"][number];
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== listRequestId || result.action !== "list") {
                continue;
            }
            expect(result.capabilities.unstableForkSession).toBe(true);
            const source = result.entries.find((candidate) => candidate.sessionId === sourceSessionId.sessionId);
            if (source === undefined) {
                throw new Error("Missing source native Session");
            }
            entry = source;
            break;
        }

        const forkRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "fork",
                sessionId: entry.sessionId,
                kind: "native.session.request",
                requestId: forkRequestId,
            }),
        );
        let forkedSessionTarget: RealDaemonPeer["target"];
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
            }
            if (kind !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== forkRequestId || result.action !== "fork") {
                continue;
            }
            forkedSessionTarget = result.target;
            expect(result.ready.target).toEqual(forkedSessionTarget);
            expect(forkedSessionTarget.sessionId).not.toBe(sourceSessionId.sessionId);
            expect(result.ready.restored).toBe(true);
            break;
        }

        const historyRequestId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 50,
                kind: "session.live-history.v2.page.load",
                requestId: historyRequestId,
                target: forkedSessionTarget,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
            }
            if (kind !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const loaded = decodeSessionHistoryPageLoaded(message);
            if (loaded.requestId !== historyRequestId) {
                continue;
            }
            expect(
                loaded.events.events.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Save this conversation so it can be forked");
            break;
        }

        const forkedCommandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                requestId: forkedCommandId,
                commandId: forkedCommandId,
                requestId: forkedCommandId,
                target: forkedSessionTarget,
                attachments: [],
                prompt: "Continue in the independent fork",
                disposition: SessionPromptDisposition.Append,
            }),
        );
        let reply = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === forkedCommandId
            ) {
                expect(reply).toContain("PI_FORK_REPLY");
                break;
            }
        }
    });
});
