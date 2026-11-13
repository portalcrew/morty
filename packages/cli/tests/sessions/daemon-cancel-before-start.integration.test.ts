import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionTurnWithdrawnEvent,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

test("Given a command already completed, When a delayed queue edit cancels it before start, Then the Computer refuses to claim that it was withdrawn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-late-queue-edit-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: "append",
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "Complete before the edit reaches the Computer",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === commandId
                    ) {
                        expect(event.payload.stopReason).toBe("end_turn");
                        break;
                    }
                }
                const withdrawal = randomUUID();
                peer.send(
                    JSON.stringify({
                        commandId,
                        kind: "session.cancel-before-start",
                        requestId: withdrawal,
                        target: peer.target,
                    }),
                );
                const reply = await peer.nextMessage();
                expect(decodeMessageKind(reply)).toBe("session.operation.failed");
                expect(decodeSessionOperationFailedEvent(reply)).toMatchObject({
                    requestId: withdrawal,
                    code: "turn_already_started",
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);

// @no-uc: Compatibility; conditional cancellation must never cancel a command which already started.
test("Given running and queued work, When cancellation permits only unstarted work, Then the queued work stops and the running work is preserved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-cancel-before-start-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const running = randomUUID();
                const queued = randomUUID();
                const prompt = (commandId: string, text: string) =>
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: "append",
                        attachments: [],
                        kind: "session.prompt",
                        prompt: text,
                        target: peer.target,
                    });
                peer.send(prompt(running, "hold after first delta"));
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.started" &&
                        event.payload.commandId === running
                    ) {
                        break;
                    }
                }
                peer.send(prompt(queued, "This queued instruction must never execute"));
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                        break;
                    }
                }
                const runningWithdrawal = randomUUID();
                peer.send(
                    JSON.stringify({
                        commandId: running,
                        kind: "session.cancel-before-start",
                        requestId: runningWithdrawal,
                        target: peer.target,
                    }),
                );
                peer.send(
                    JSON.stringify({
                        commandId: queued,
                        kind: "session.cancel-before-start",
                        requestId: crypto.randomUUID(),
                        target: peer.target,
                    }),
                );
                peer.send(
                    encodeSessionCancelCommand({
                        commandId: running,
                        kind: "session.cancel",
                        requestId: crypto.randomUUID(),
                        target: peer.target,
                    }),
                );
                const completed = new Map<string, string>();
                let queuedStarted = false;
                let runningRefusal: string | undefined;
                while (completed.size < 2) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) === "session.operation.failed") {
                        const failure = decodeSessionOperationFailedEvent(raw);
                        if (failure.requestId === runningWithdrawal) {
                            runningRefusal = failure.code;
                        }
                        continue;
                    }
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(raw).events) {
                        if (event.type !== "lifecycle-metadata") {
                            continue;
                        }
                        if (event.payload.kind === "prompt.started" && event.payload.commandId === queued) {
                            queuedStarted = true;
                        }
                        if (event.payload.kind === "prompt.completed") {
                            completed.set(event.payload.commandId, event.payload.stopReason);
                            if (event.payload.commandId === queued) {
                                expect(event.payload).toMatchObject({ execution: "not-started" });
                            } else {
                                expect(event.payload).not.toHaveProperty("execution");
                            }
                            expect(event.payload.stopReason).toBe("cancelled");
                        }
                    }
                }
                expect(queuedStarted).toBe(false);
                expect(completed.get(queued)).toBe("cancelled");
                expect(runningRefusal).toBe("turn_already_started");
                const next = randomUUID();
                peer.send(prompt(next, "The next request completes"));
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === next
                    ) {
                        expect(event.payload.stopReason).toBe("end_turn");
                        break;
                    }
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);

// @no-uc: Technical regression; cancelling an unacknowledged command prevents its delayed admission.
test("Given an unacknowledged command, When Stop arrives before its prompt, Then a recorded cancellation prevents later execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-cancel-admission-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const stopped = randomUUID();
                const withdrawal = randomUUID();
                peer.send(
                    JSON.stringify({
                        commandId: stopped,
                        kind: "session.cancel-before-start",
                        requestId: withdrawal,
                        target: peer.target,
                    }),
                );
                let cancelled = false;
                let withdrawn = false;
                while (!cancelled || !withdrawn) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) === "session.operation.failed") {
                        expect(decodeSessionOperationFailedEvent(raw).requestId).not.toBe(withdrawal);
                    }
                    if (decodeMessageKind(raw) === "session.turn.withdrawn") {
                        expect(decodeSessionTurnWithdrawnEvent(raw)).toMatchObject({
                            commandId: stopped,
                            requestId: withdrawal,
                        });
                        withdrawn = true;
                    }
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    cancelled ||= decodeSessionEventEnvelope(raw).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === stopped &&
                            event.payload.stopReason === "cancelled",
                    );
                }
                const prompt = (commandId: string) =>
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: "append",
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "This request completes normally",
                        target: peer.target,
                    });
                peer.send(prompt(stopped));
                const next = randomUUID();
                peer.send(prompt(next));
                let stoppedStarted = false;
                let nextCompleted = false;
                while (!nextCompleted) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(raw).events) {
                        if (event.type !== "lifecycle-metadata") {
                            continue;
                        }
                        if (event.payload.kind === "prompt.started" && event.payload.commandId === stopped) {
                            stoppedStarted = true;
                        }
                        if (event.payload.kind === "prompt.completed" && event.payload.commandId === next) {
                            expect(event.payload.stopReason).toBe("end_turn");
                            nextCompleted = true;
                        }
                    }
                }
                expect(stoppedStarted).toBe(false);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);

function fileCreated(directory: string, name: string): Promise<void> {
    const created = Promise.withResolvers<void>();
    const watcher = watch(directory, () => {
        if (existsSync(join(directory, name))) {
            watcher.close();
            created.resolve();
        }
    });
    if (existsSync(join(directory, name))) {
        watcher.close();
        created.resolve();
    }
    return created.promise;
}

test("Given a prompt still loading its conversation's saved history, When the client withdraws it, Then the Computer withdraws it before it starts and the next prompt runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-withdraw-loading-"));
    try {
        const agentDirectory = join(directory, "agent");
        await mkdir(agentDirectory, { recursive: true });
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: agentDirectory, PATH: executableDirectory },
            async (peer) => {
                const prompt = (commandId: string, text: string) =>
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: "append",
                        attachments: [],
                        kind: "session.prompt",
                        prompt: text,
                        target: peer.target,
                    });
                const completed = async (commandId: string): Promise<void> => {
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId
                        ) {
                            expect(event.payload.stopReason).toBe("end_turn");
                            return;
                        }
                    }
                };
                const first = randomUUID();
                peer.send(prompt(first, "Start a conversation with saved history"));
                await completed(first);
                // After a restart the next prompt replays the saved history before it reaches the Agent.
                await peer.restart();
                await writeFile(join(agentDirectory, "pause-load"), "");
                const loading = fileCreated(agentDirectory, "load-paused");
                const withdrawn = randomUUID();
                peer.send(prompt(withdrawn, "This request is withdrawn before it starts"));
                await loading;

                const withdrawal = randomUUID();
                peer.send(
                    JSON.stringify({
                        commandId: withdrawn,
                        kind: "session.cancel-before-start",
                        requestId: withdrawal,
                        target: peer.target,
                    }),
                );

                let started = false;
                let settled = false;
                while (!settled) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) === "session.operation.failed") {
                        expect(decodeSessionOperationFailedEvent(raw).requestId).not.toBe(withdrawal);
                    }
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(raw).events) {
                        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
                            continue;
                        }
                        if (event.payload.commandId !== withdrawn) {
                            continue;
                        }
                        expect(event.payload.kind).not.toBe("prompt.failed-before-start");
                        if (event.payload.kind === "prompt.started") {
                            started = true;
                        }
                        if (event.payload.kind === "prompt.completed") {
                            expect(event.payload).toMatchObject({ execution: "not-started", stopReason: "cancelled" });
                            settled = true;
                        }
                    }
                }
                expect(started).toBe(false);
                await rm(join(agentDirectory, "pause-load"));
                const next = randomUUID();
                peer.send(prompt(next, "The next request completes"));
                await completed(next);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);
