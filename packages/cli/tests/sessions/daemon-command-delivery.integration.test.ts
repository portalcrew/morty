import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    isPromptTerminal,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";
import { fileCreated } from "../support/file-created.ts";

const submit = (peer: RealDaemonPeer, commandId: string, prompt: string): void =>
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            kind: "session.prompt",
            prompt,
            target: peer.target,
        }),
    );

const waitForLifecycle = async (peer: RealDaemonPeer, commandId: string, kind: string) => {
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === kind && "commandId" in event.payload) {
            if (event.payload.commandId === commandId) {
                return event.payload;
            }
        }
    }
};

const readExecution = async (peer: RealDaemonPeer, commandId?: string) => {
    const requestId = randomUUID();
    peer.send(
        JSON.stringify({
            action: "active-turn",
            ...(commandId === undefined ? {} : { deliveryCommandId: commandId }),
            kind: "native.session.request",
            requestId,
            target: peer.target,
        }),
    );
    for (;;) {
        const raw = await peer.nextMessage();
        if (decodeMessageKind(raw) !== NATIVE_SESSION_RESULT_KIND) {
            continue;
        }
        const result = decodeNativeSessionResult(raw);
        if (result.requestId === requestId && result.action === "active-turn") {
            return { raw: JSON.parse(raw) as Record<string, unknown>, result };
        }
    }
};

// @no-uc: Compatibility; a reconnecting client recovers an unconfirmed submission from the Computer's execution receipt.
test("Given commands the Computer finished, failed, is running or never received, When a client reads the Session execution naming each command, Then the Computer reports whether it received each command, also after a restart", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-command-delivery-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const completed = randomUUID();
                submit(peer, completed, "The request completes");
                await waitForLifecycle(peer, completed, "prompt.completed");
                const failed = randomUUID();
                submit(peer, failed, "fail with model unavailable");
                await waitForLifecycle(peer, failed, "prompt.failed");
                const running = randomUUID();
                submit(peer, running, "hold after first delta");
                await waitForLifecycle(peer, running, "prompt.started");
                const neverReceived = randomUUID();

                for (const received of [completed, failed]) {
                    expect((await readExecution(peer, received)).result).toMatchObject({
                        delivery: { commandId: received, state: "received" },
                    });
                }
                expect((await readExecution(peer, running)).result).toMatchObject({
                    delivery: { commandId: running, state: "received" },
                    turn: { commandId: running },
                });
                expect((await readExecution(peer, neverReceived)).result).toMatchObject({
                    delivery: { commandId: neverReceived, state: "unknown" },
                });
                expect((await readExecution(peer)).raw).not.toHaveProperty("delivery");

                await peer.restart();
                for (const received of [completed, running]) {
                    expect((await readExecution(peer, received)).result).toMatchObject({
                        delivery: { commandId: received, state: "received" },
                    });
                }
                expect((await readExecution(peer, neverReceived)).result).toMatchObject({
                    delivery: { commandId: neverReceived, state: "unknown" },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);

test("Given a running turn and a later queued command, When the clock moves backwards and the daemon restarts twice, Then both reads report the queued command's restart failure", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-28T10:00:00Z"), toFake: ["Date"] });
    const directory = await mkdtemp(join(tmpdir(), "morty-last-turn-order-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const running = "a-running";
                const queued = "z-queued";
                submit(peer, running, "hold after first delta");
                await waitForLifecycle(peer, running, "prompt.started");
                // Exercise backwards ordering without making the client's newly signed
                // packets older than the Computer's independently enforced replay window.
                vi.setSystemTime(new Date("2026-10-28T09:59:59Z"));
                peer.send(
                    encodeSessionPromptCommand({
                        attachments: [],
                        commandId: queued,
                        requestId: queued,
                        disposition: SessionPromptDisposition.Append,
                        kind: "session.prompt",
                        prompt: "Continue with the queued request",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                        break;
                    }
                }

                vi.setSystemTime(new Date("2026-10-28T11:00:00Z"));
                await peer.restart();
                const first = (await readExecution(peer)).result.lastTurn;
                await peer.restart();
                const second = (await readExecution(peer)).result.lastTurn;
                expect([first, second]).toMatchObject([
                    {
                        commandId: queued,
                        state: "failed",
                        code: "runtime_restarted",
                    },
                    {
                        commandId: queued,
                        state: "failed",
                        code: "runtime_restarted",
                    },
                ]);
                expect(first).toEqual(second);

                // All three receipts now share a timestamp; command IDs cannot decide recency.
                const next = "0-next";
                submit(peer, next, "A newer turn replaces the restart failure");
                await waitForLifecycle(peer, next, "prompt.completed");
                const completed = (await readExecution(peer)).result.lastTurn;
                expect(completed).toMatchObject({ commandId: next, state: "completed", stopReason: "end_turn" });
                await peer.restart();
                expect((await readExecution(peer)).result.lastTurn).toEqual(completed);
            },
        );
    } finally {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);

// @no-uc: Compatibility; a client that missed a turn's live outcome recovers it from the Computer's execution receipts.
test("Given turns that complete, fail, run or are interrupted by a restart, When a client reads the Session execution, Then it reports how the last started turn ended until a newer turn replaces it", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-last-turn-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                expect((await readExecution(peer)).raw).not.toHaveProperty("lastTurn");

                const completed = randomUUID();
                submit(peer, completed, "The request completes");
                await waitForLifecycle(peer, completed, "prompt.completed");
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { commandId: completed, state: "completed", stopReason: "end_turn" },
                });

                const failed = randomUUID();
                const rejectedPrompt = "fail echoing the prompt CANARY-prompt-body-9f3a";
                submit(peer, failed, rejectedPrompt);
                const failure = await waitForLifecycle(peer, failed, "prompt.failed");
                expect(failure).toMatchObject({
                    code: "acp_agent_error",
                    message: "Internal error: Rejected prompt: CANARY-prompt-body-9f3a",
                });
                const expectedFailure = {
                    lastTurn: {
                        commandId: failed,
                        state: "failed",
                        code: "acp_agent_error",
                        message: "Internal error: Rejected prompt: CANARY-prompt-body-9f3a",
                    },
                };
                expect((await readExecution(peer)).result).toMatchObject(expectedFailure);
                await peer.restart();
                // Public Agent text can quote user input. Only a content-free summary survives restart.
                const persistedMessage = "The local Agent could not complete the request";
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { ...expectedFailure.lastTurn, message: persistedMessage },
                });

                // Replaying the same command uses the durable summary without running it again.
                submit(peer, failed, rejectedPrompt);
                expect(await waitForLifecycle(peer, failed, "prompt.failed")).toEqual({
                    ...failure,
                    message: persistedMessage,
                });

                const interrupted = randomUUID();
                submit(peer, interrupted, "hold after first delta");
                await waitForLifecycle(peer, interrupted, "prompt.started");
                const running = await readExecution(peer);
                expect(running.result).toMatchObject({ turn: { commandId: interrupted } });
                expect(running.raw).not.toHaveProperty("lastTurn");

                await peer.restart();
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { commandId: interrupted, state: "failed", code: "runtime_restarted" },
                });

                const next = randomUUID();
                submit(peer, next, "The next request completes");
                await waitForLifecycle(peer, next, "prompt.completed");
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { commandId: next, state: "completed", stopReason: "end_turn" },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);

// @no-uc: Compatibility; a steering prompt folds into the turn it steers, so that turn's outcome is the last turn.
test.for([
    {
        ending: "completes",
        instruction: "Apply the steering instruction",
        live: { state: "completed", stopReason: "end_turn" },
        restored: { state: "completed", stopReason: "end_turn" },
    },
    {
        ending: "fails",
        instruction: "fail with model unavailable",
        live: {
            state: "failed",
            code: "acp_agent_error",
            message: "Internal error: Model unavailable: controlled/test-model",
        },
        restored: {
            state: "failed",
            code: "acp_agent_error",
            message: "The local Agent could not complete the request",
        },
    },
])(
    "Given a running turn steered by a queued prompt, When the turn $ending and a client reads the Session execution, Then it reports how the steered turn ended, also after a restart",
    { timeout: 90_000 },
    async ({ instruction, live, restored }, { signal }) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-last-turn-steered-"));
        try {
            const executableDirectory = await writeControlledAcpExecutable(directory);
            await withControlledDaemon(
                signal,
                new ControlledAcpAgentSpecification(),
                {
                    MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                    PATH: executableDirectory,
                },
                async (peer) => {
                    const turn = randomUUID();
                    submit(peer, turn, "wait for steering");
                    await waitForLifecycle(peer, turn, "prompt.started");
                    const steering = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            attachments: [],
                            commandId: steering,
                            requestId: steering,
                            disposition: SessionPromptDisposition.Append,
                            kind: "session.prompt",
                            prompt: instruction,
                            target: peer.target,
                        }),
                    );
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                            break;
                        }
                    }
                    peer.send(
                        encodeSessionPromptDispositionCommand({
                            commandId: steering,
                            disposition: SessionPromptDisposition.Steer,
                            kind: SESSION_PROMPT_DISPOSITION_KIND,
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                        }),
                    );
                    const settled = new Set<string>();
                    while (!settled.has(turn) || !settled.has(steering)) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type === "lifecycle-metadata" && isPromptTerminal(event.payload)) {
                            settled.add(event.payload.commandId);
                        }
                    }
                    expect((await readExecution(peer, steering)).result).toMatchObject({
                        delivery: { commandId: steering, state: "received" },
                        lastTurn: { commandId: turn, ...live },
                        turn: null,
                    });
                    await peer.restart();
                    expect((await readExecution(peer)).result).toMatchObject({
                        lastTurn: { commandId: turn, ...restored },
                    });
                },
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

// @no-uc: Compatibility; a client that opens a Session another device is preparing a turn for must not see the failure of the turn before.
test("Given a turn that failed and a new turn still loading the Session's saved history, When a client reads the Session execution, Then it reports no ended turn while the Session works", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-last-turn-preparing-"));
    try {
        const agentDirectory = join(directory, "agent");
        await mkdir(agentDirectory, { recursive: true });
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: agentDirectory, PATH: executableDirectory },
            async (peer) => {
                const failed = randomUUID();
                submit(peer, failed, "fail echoing the prompt CANARY-prompt-body-9f3a");
                await waitForLifecycle(peer, failed, "prompt.failed");
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { commandId: failed, state: "failed" },
                });

                // After a restart the next prompt replays the saved history before it reaches the Agent.
                await peer.restart();
                await writeFile(join(agentDirectory, "pause-load"), "");
                const loading = fileCreated(agentDirectory, "load-paused");
                const next = randomUUID();
                submit(peer, next, "The next request completes");
                await loading;

                const preparing = await readExecution(peer);
                expect(preparing.result).toMatchObject({ turn: null });
                expect(preparing.raw).not.toHaveProperty("lastTurn");

                await rm(join(agentDirectory, "pause-load"));
                await waitForLifecycle(peer, next, "prompt.completed");
                expect((await readExecution(peer)).result).toMatchObject({
                    lastTurn: { commandId: next, state: "completed" },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
