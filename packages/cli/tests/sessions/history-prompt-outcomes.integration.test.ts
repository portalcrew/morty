import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    type NativeSessionEvents,
    SESSION_PROMPT_DISPOSITION_KIND,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { prepareNewRealSession, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], commandId: string, prompt: string) =>
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            requestId: commandId,
            commandId,
            requestId: commandId,
            disposition: "append",
            kind: "session.prompt",
            prompt,
            target: sessionTarget,
        }),
    );

async function liveUntil(peer: RealDaemonPeer, matches: (event: SessionLiveEvent) => boolean): Promise<void> {
    for (;;) {
        const raw = await peer.nextMessage();
        if (decodeMessageKind(raw) !== "session.event.v2") {
            continue;
        }
        for (const event of decodeSessionEventEnvelope(raw).events) {
            if (matches(event)) {
                return;
            }
        }
    }
}

const terminal = (commandId: string) => (event: SessionLiveEvent) =>
    event.type === "lifecycle-metadata" &&
    (event.payload.kind === "prompt.completed" || event.payload.kind === "prompt.failed") &&
    event.payload.commandId === commandId;

/** The history page's user messages and turn lifecycle, in page order. */
const timeline = (page: NativeSessionEvents): readonly string[] =>
    page.events.events.flatMap((event) => {
        if (event.type === "acp") {
            return event.payload.sessionUpdate === "user_message_chunk" ? [`user ${event.payload.messageId}`] : [];
        }
        return "commandId" in event.payload ? [`${event.payload.kind} ${event.payload.commandId}`] : [];
    });

async function historyPage(
    peer: RealDaemonPeer,
    sessionTarget: RealDaemonPeer["target"],
): Promise<NativeSessionEvents> {
    const requestId = randomUUID();
    peer.send(
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId,
            target: sessionTarget,
            eventLimit: 1_000,
            cursor: null,
        }),
    );
    for (;;) {
        const raw = await peer.nextMessage();
        const kind = decodeMessageKind(raw);
        if (kind === "session.operation.failed") {
            throw new Error(raw);
        }
        if (kind === "session.live-history.v2.page.loaded") {
            const loaded = decodeSessionHistoryPageLoaded(raw);
            if (loaded.requestId === requestId) {
                return loaded.events;
            }
        }
    }
}

test("Given a failed turn and a completed turn, When a client reads the replayed Session history, Then each turn's start and ending surround its own user message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-outcomes-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const failed = randomUUID();
                const completed = randomUUID();
                const sessionTarget = await prepareNewRealSession(peer, "controlled-acp");
                // The failed prompt retires the Agent process, so the history read after it replays the Agent's own
                // transcript, which holds no command identity.
                submit(peer, sessionTarget, failed, "fail with model unavailable");
                await liveUntil(peer, terminal(failed));
                submit(peer, sessionTarget, completed, "The request completes");
                await liveUntil(peer, terminal(completed));

                const page = await historyPage(peer, sessionTarget);

                // The replayed history holds each turn's lifecycle around the user message its Agent recorded, and
                // each ending where its turn ended.
                expect(timeline(page)).toEqual([
                    `prompt.requested ${failed}`,
                    `prompt.started ${failed}`,
                    "user user-1",
                    `prompt.failed ${failed}`,
                    `prompt.requested ${completed}`,
                    `prompt.started ${completed}`,
                    "user user-2",
                    `prompt.completed ${completed}`,
                ]);
                expect(page.events.events).toContainEqual(
                    expect.objectContaining({
                        payload: expect.objectContaining({
                            code: "acp_agent_error",
                            commandId: failed,
                            kind: "prompt.failed",
                            message: "Internal error: Model unavailable: controlled/test-model",
                        }),
                        type: "lifecycle-metadata",
                    }),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);

test("Given a turn steered by a queued prompt, When a client reads the Session history, Then the steering sits inside the turn it joined", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-steered-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const turn = randomUUID();
                const steering = randomUUID();
                const sessionTarget = await prepareNewRealSession(peer, "controlled-acp");
                submit(peer, sessionTarget, turn, "wait for steering");
                await liveUntil(
                    peer,
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.started" &&
                        event.payload.commandId === turn,
                );
                submit(peer, sessionTarget, steering, "Apply the steering instruction");
                await liveUntil(
                    peer,
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                );
                peer.send(
                    encodeSessionPromptDispositionCommand({
                        commandId: steering,
                        disposition: "steer",
                        kind: SESSION_PROMPT_DISPOSITION_KIND,
                        requestId: crypto.randomUUID(),
                        target: sessionTarget,
                    }),
                );
                // The steering prompt and the turn it joined settle in either order.
                const settled = new Set<string>();
                await liveUntil(peer, (event) => {
                    for (const commandId of [turn, steering]) {
                        if (terminal(commandId)(event)) {
                            settled.add(commandId);
                        }
                    }
                    return settled.size === 2;
                });

                const page = await historyPage(peer, sessionTarget);

                // The steering joins the running turn: its lifecycle follows the turn's start, and the turn ends last.
                const order = timeline(page);
                const position = (entry: string) => {
                    const index = order.indexOf(entry);
                    expect(index, entry).toBeGreaterThanOrEqual(0);
                    return index;
                };
                expect(order.filter((entry) => entry.startsWith("user "))).toHaveLength(2);
                expect(position(`prompt.started ${turn}`)).toBeLessThan(position(`prompt.started ${steering}`));
                expect(position(`prompt.completed ${steering}`)).toBeLessThan(position(`prompt.completed ${turn}`));
                expect(order.at(-1)).toBe(`prompt.completed ${turn}`);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
