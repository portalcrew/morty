import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const prompt = (peer: RealDaemonPeer, commandId: string, text: string) =>
    encodeSessionPromptCommand({
        attachments: [],
        commandId,
        requestId: commandId,
        disposition: "append",
        kind: "session.prompt",
        prompt: text,
        target: peer.target,
    });

const append = (peer: RealDaemonPeer, commandId: string, text: string) => peer.send(prompt(peer, commandId, text));

type Frame =
    | { readonly kind: "event"; readonly event: SessionLiveEvent }
    | { readonly kind: "message"; readonly message: Readonly<Record<string, unknown>> };

/** Every frame the daemon sent, in order, and how far the scenario has read them. */
interface FrameLog {
    readonly frames: Frame[];
    read: number;
}

/** Reads the daemon's frames in order until one matches; frames after it stay unread. */
async function next(peer: RealDaemonPeer, log: FrameLog, matches: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
        while (log.read < log.frames.length) {
            const frame = log.frames[log.read];
            log.read += 1;
            if (frame !== undefined && matches(frame)) {
                return frame;
            }
        }
        const raw = await peer.nextMessage();
        log.frames.push(
            ...(decodeMessageKind(raw) === "session.event.v2"
                ? decodeSessionEventEnvelope(raw).events.map((event): Frame => ({ kind: "event", event }))
                : [{ kind: "message", message: JSON.parse(raw) as Record<string, unknown> } satisfies Frame]),
        );
    }
}

const lifecycle =
    (kind: string, commandId?: string) =>
    (frame: Frame): boolean =>
        frame.kind === "event" &&
        frame.event.type === "lifecycle-metadata" &&
        frame.event.payload.kind === kind &&
        (commandId === undefined ||
            ("commandId" in frame.event.payload && frame.event.payload.commandId === commandId));

test("Given a running prompt, When clients append messages and steer a turn that is not running, Then every message is queued and runs in order and the refused steer leaves its identifier unused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-prompt-acknowledgement-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const seen: FrameLog = { frames: [], read: 0 };
                const running = randomUUID();
                append(peer, running, "hold after first delta");
                await next(peer, seen, lifecycle("prompt.started", running));

                // Two clients send without knowing a turn runs. The Computer queues both, in arrival order, and names
                // each in the queue change that acknowledges it.
                const first = randomUUID();
                const second = randomUUID();
                append(peer, first, "The request completes");
                append(peer, second, "The request completes");
                for (const commandId of [first, second]) {
                    const change = await next(peer, seen, lifecycle("session.queue.changed"));
                    expect(change.kind === "event" && change.event.payload).toEqual({
                        changedByCommandId: commandId,
                        kind: "session.queue.changed",
                    });
                }

                // A steer joins only a running turn. Naming a queued one, it is refused without being admitted.
                const steer = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        attachments: [],
                        commandId: steer,
                        requestId: steer,
                        disposition: "steer",
                        kind: "session.prompt",
                        prompt: "Use this in the same turn",
                        target: peer.target,
                        targetCommandId: first,
                    }),
                );
                const refused = await next(
                    peer,
                    seen,
                    (frame) => frame.kind === "message" && frame.message["kind"] === "session.operation.failed",
                );
                expect(refused.kind === "message" && refused.message).toMatchObject({
                    code: "steering_target_unavailable",
                    requestId: steer,
                });
                // The refused identifier was never spent: the same command appended now is queued like any other.
                append(peer, steer, "The request completes");
                const change = await next(peer, seen, lifecycle("session.queue.changed"));
                expect(change.kind === "event" && change.event.payload).toEqual({
                    changedByCommandId: steer,
                    kind: "session.queue.changed",
                });

                // A retry of the running command records nothing new and is answered directly.
                append(peer, running, "hold after first delta");
                const accepted = await next(
                    peer,
                    seen,
                    (frame) => frame.kind === "message" && frame.message["kind"] === "session.prompt.accepted",
                );
                expect(accepted.kind === "message" && accepted.message).toEqual({
                    kind: "session.prompt.accepted",
                    requestId: running,
                    target: peer.target,
                    state: "running",
                });

                peer.send(
                    JSON.stringify({
                        kind: "session.cancel",
                        requestId: crypto.randomUUID(),
                        commandId: running,
                        target: peer.target,
                    }),
                );
                const order: string[] = [];
                while (order.length < 3) {
                    const started = await next(peer, seen, lifecycle("prompt.started"));
                    if (
                        started.kind === "event" &&
                        started.event.type === "lifecycle-metadata" &&
                        started.event.payload.kind === "prompt.started"
                    ) {
                        order.push(started.event.payload.commandId);
                    }
                    await next(peer, seen, lifecycle("prompt.completed", order.at(-1)));
                }
                expect(order).toEqual([first, second, steer]);
                expect(
                    seen.frames.some(
                        (frame) =>
                            frame.kind === "event" &&
                            frame.event.type === "lifecycle-metadata" &&
                            (frame.event.payload.kind === "prompt.failed" ||
                                frame.event.payload.kind === "prompt.failed-before-start"),
                    ),
                ).toBe(false);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
