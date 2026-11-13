import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Compatibility; restart receipts distinguish started, queued and completed commands through the daemon wire protocol.
test("Given running and queued prompts, When the daemon restarts, Then it reports restart outcomes and only unstarted commands can be resubmitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-restart-receipts-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const identity = {
                    harness: "controlled-acp",
                    directory: ".",
                    attachments: [],
                    kind: "session.prompt" as const,
                    target: peer.target,
                };
                const running = randomUUID();
                const queued = randomUUID();
                const original = encodeSessionPromptCommand({
                    ...identity,
                    commandId: running,
                    requestId: running,
                    disposition: SessionPromptDisposition.Append,
                    prompt: "hold after first delta",
                });
                peer.send(original);
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
                const followup = encodeSessionPromptCommand({
                    ...identity,
                    commandId: queued,
                    requestId: queued,
                    disposition: SessionPromptDisposition.Append,
                    prompt: "Finish the queued follow-up",
                });
                peer.send(followup);
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                        break;
                    }
                }
                await peer.restart();
                const outcomes = new Map<string, string>();
                while (outcomes.size < 2) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        expect(event.payload.code).toBe("runtime_restarted");
                        outcomes.set(event.payload.commandId, event.payload.kind);
                    }
                }
                expect(outcomes.get(running)).toBe("prompt.failed");
                expect(outcomes.get(queued)).toBe("prompt.failed-before-start");
                peer.send(original);
                const continuation = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        ...identity,
                        commandId: continuation,
                        requestId: continuation,
                        disposition: SessionPromptDisposition.Append,
                        prompt: "Continue unfinished work",
                    }),
                );
                peer.send(followup);
                const completed: string[] = [];
                while (completed.length < 2) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                        expect(event.payload.commandId).not.toBe(running);
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        completed.push(event.payload.commandId);
                    }
                }
                expect(completed).toEqual([continuation, queued]);
                await peer.restart();
                const retained = new Set<string>();
                while (retained.size < 2) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        retained.add(event.payload.commandId);
                    }
                }
                expect(retained).toEqual(new Set([continuation, queued]));
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
