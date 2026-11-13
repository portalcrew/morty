import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { command } from "../../src/engine/schema/acp-session-store/command.ts";
import {
    computerSessionDatabasePaths,
    openAcpSessionDatabase,
} from "../../src/engine/storage/sqlite/local-databases.ts";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, commandId: string) =>
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: "append",
            kind: "session.prompt",
            prompt: "The request completes",
            target: peer.target,
        }),
    );

type Frame =
    | { readonly kind: "event"; readonly event: SessionLiveEvent }
    | { readonly kind: "message"; readonly message: Readonly<Record<string, unknown>> };

/** Reads the daemon's frames in order until one matches. */
async function next(peer: RealDaemonPeer, seen: Frame[], matches: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
        const raw = await peer.nextMessage();
        const frames: Frame[] =
            decodeMessageKind(raw) === "session.event.v2"
                ? decodeSessionEventEnvelope(raw).events.map((event) => ({ kind: "event", event }))
                : [{ kind: "message", message: JSON.parse(raw) as Record<string, unknown> }];
        for (const frame of frames) {
            seen.push(frame);
            if (matches(frame)) {
                return frame;
            }
        }
    }
}

const completed = (commandId: string) => (frame: Frame) =>
    frame.kind === "event" &&
    frame.event.type === "lifecycle-metadata" &&
    frame.event.payload.kind === "prompt.completed" &&
    frame.event.payload.commandId === commandId;

const accepted = (commandId: string) => (frame: Frame) =>
    frame.kind === "message" &&
    frame.message["kind"] === "session.prompt.accepted" &&
    frame.message["requestId"] === commandId;

/**
 * Retries a settled command and runs another one after it. Returns the outcomes published for the retried command
 * from the retry until the other command completed.
 */
async function retrySettled(peer: RealDaemonPeer, commandId: string): Promise<readonly SessionLiveEvent[]> {
    const seen: Frame[] = [];
    submit(peer, commandId);
    const answer = await next(peer, seen, accepted(commandId));
    expect(answer.kind === "message" && answer.message["state"]).toBe("settled");
    await next(peer, seen, completed(commandId));
    const following = randomUUID();
    submit(peer, following);
    await next(peer, seen, completed(following));
    return seen.filter(completed(commandId)).flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));
}

test("Given a completed prompt, When a client retries it before and after a daemon restart, Then each retry is answered settled and restates the outcome once, marked as restated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-settled-prompt-retry-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const commandId = randomUUID();
                submit(peer, commandId);
                const original = await next(peer, [], completed(commandId));
                if (original.kind !== "event") {
                    throw new Error("Expected the command's outcome");
                }
                expect(original.event.mortyMetadata?.restated).toBeUndefined();
                // A restatement keeps when the outcome was recorded: receivers that predate the restated marker
                // report that time as when the command ended. It is marked as the outcome the Computer recorded.
                const restatement = {
                    payload: original.event.payload,
                    mortyMetadata: { restated: true },
                    recordedAt: original.event.recordedAt,
                };

                // The same command and payload, as a client retries a submission whose response was lost.
                expect(await retrySettled(peer, commandId)).toEqual([expect.objectContaining(restatement)]);

                await peer.restart();
                // A restart publishes each retained outcome once, restated: the previous process recorded it.
                const recovered = await next(peer, [], completed(commandId));
                expect(recovered).toMatchObject({ kind: "event", event: restatement });
                expect(await retrySettled(peer, commandId)).toEqual([expect.objectContaining(restatement)]);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);

test("Given a persisted legacy prompt receipt, When the prompt is retried with a new reply address, Then it is restated and a changed prompt conflicts", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    const directory = await mkdtemp(join(tmpdir(), "morty-legacy-receipt-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const commandId = randomUUID();
                submit(peer, commandId);
                await next(peer, [], completed(commandId));
                // c34752d2a encoded these fields in this order and required equal IDs.
                const legacy = JSON.stringify({
                    commandId,
                    requestId: commandId,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "The request completes",
                    target: peer.target,
                    disposition: "append",
                });
                await peer.restart(undefined, async () => {
                    const database = openAcpSessionDatabase(
                        computerSessionDatabasePaths(peer.stateDirectory, "real-agent").sessions,
                    );
                    try {
                        database.orm
                            .update(command)
                            .set({ commandHash: createHash("sha256").update(legacy).digest("hex") })
                            .where(eq(command.commandId, commandId))
                            .run();
                    } finally {
                        database.close();
                    }
                });
                const requestId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId,
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "The request completes",
                        target: peer.target,
                        disposition: "append",
                    }),
                );
                const answer = await next(
                    peer,
                    [],
                    (frame) => frame.kind === "message" && frame.message["requestId"] === requestId,
                );
                expect(answer).toMatchObject({
                    kind: "message",
                    message: { kind: "session.prompt.accepted", requestId, state: "settled" },
                });
                const conflictId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: conflictId,
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "Different intent",
                        target: peer.target,
                        disposition: "append",
                    }),
                );
                const conflict = await next(
                    peer,
                    [],
                    (frame) => frame.kind === "message" && frame.message["requestId"] === conflictId,
                );
                expect(conflict).toMatchObject({
                    kind: "message",
                    message: {
                        kind: "session.operation.failed",
                        requestId: conflictId,
                        code: "command_identity_conflict",
                    },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 120_000);
