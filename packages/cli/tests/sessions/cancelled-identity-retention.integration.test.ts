import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    encodeSessionPromptCommand,
    NATIVE_SESSION_RESULT_KIND,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

async function observe(peer: RealDaemonPeer, ids: readonly string[]) {
    const pending = new Set(ids);
    const started: string[] = [];
    const failures: string[] = [];
    const cancelled: string[] = [];
    let output = "";
    while (pending.size > 0) {
        const raw = await peer.nextMessage();
        const kind = decodeMessageKind(raw);
        if (kind === "session.operation.failed") {
            const event = decodeSessionOperationFailedEvent(raw);
            if (pending.delete(event.requestId)) {
                failures.push(event.code ?? "unknown");
            }
        } else if (kind === "session.event.v2") {
            for (const event of decodeSessionEventEnvelope(raw).events) {
                if (event.type === "acp") {
                    if (
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        output += event.payload.content.text;
                    }
                    continue;
                }
                const payload = event.payload;
                if (payload.kind === "prompt.started") {
                    started.push(payload.commandId);
                }
                if (
                    payload.kind === "prompt.completed" &&
                    pending.has(payload.commandId) &&
                    payload.stopReason === "cancelled" &&
                    payload.execution === "not-started"
                ) {
                    cancelled.push(payload.commandId);
                }
                if (
                    payload.kind === "prompt.completed" ||
                    payload.kind === "prompt.failed" ||
                    payload.kind === "prompt.failed-before-start"
                ) {
                    pending.delete(payload.commandId);
                }
            }
        }
    }
    return { started, failures, cancelled, output };
}

/** Reads the command's delivery the way a reconnecting client recovers an unconfirmed submission. */
async function readDelivery(peer: RealDaemonPeer, commandId: string) {
    const requestId = randomUUID();
    peer.send(
        JSON.stringify({
            action: "active-turn",
            deliveryCommandId: commandId,
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
            return result.command;
        }
    }
}

const promptCommand = (peer: RealDaemonPeer, commandId: string, prompt: string) =>
    encodeSessionPromptCommand({
        attachments: [],
        requestId: commandId,
        commandId,
        requestId: commandId,
        disposition: "append",
        kind: "session.prompt",
        prompt,
        target: peer.target,
    });

const cancelBeforeStart = (peer: RealDaemonPeer, commandId: string) =>
    peer.send(
        JSON.stringify({
            kind: "session.cancel-before-start",
            requestId: crypto.randomUUID(),
            target: peer.target,
            commandId,
        }),
    );

test("Given an executed command and a command cancelled before start, When later commands evict both receipts without a restart, Then the cancelled command reads as cancelled rather than expired and cannot execute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-cancelled-delivery-"));
    try {
        const executable = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executable },
            async (peer) => {
                // Receipts share one timestamp, so eviction keeps the identifiers that sort last.
                const executed = promptCommand(peer, "a-executed", "The request completes");
                peer.send(executed);
                expect((await observe(peer, ["a-executed"])).started).toEqual(["a-executed"]);
                cancelBeforeStart(peer, "a-cancelled");
                expect((await observe(peer, ["a-cancelled"])).cancelled).toEqual(["a-cancelled"]);
                const pruners = Array.from({ length: 1026 }, (_, index) => `z-prune-${String(index).padStart(4, "0")}`);
                for (const id of pruners) {
                    cancelBeforeStart(peer, id);
                }
                await observe(peer, pruners);

                expect(await readDelivery(peer, "a-cancelled")).toEqual({
                    state: "completed",
                    stopReason: "cancelled",
                });
                expect(await readDelivery(peer, "a-executed")).toEqual({ state: "expired" });
                peer.send(promptCommand(peer, "a-cancelled", "This command was already cancelled"));
                expect(await observe(peer, ["a-cancelled"])).toEqual({
                    started: [],
                    failures: ["command_identity_conflict"],
                    cancelled: [],
                    output: "",
                });
                peer.send(executed);
                expect(await observe(peer, ["a-executed"])).toEqual({
                    started: [],
                    failures: ["command_result_expired"],
                    cancelled: [],
                    output: "",
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);

for (const admission of ["before-admission", "queued"] as const) {
    test(`Given a command was explicitly cancelled ${admission}, When receipts are evicted and the Computer restarts, Then the command cannot execute again and cancellation remains unstarted`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
        const directory = await mkdtemp(join(tmpdir(), "morty-cancelled-identity-"));
        try {
            const executable = await writeControlledAcpExecutable(directory);
            await withControlledDaemon(
                new ControlledAcpAgentSpecification(),
                { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executable },
                async (peer) => {
                    const commandId = "a-cancelled-original";
                    const cancel = (id: string) =>
                        peer.send(
                            JSON.stringify({
                                kind: "session.cancel-before-start",
                                requestId: crypto.randomUUID(),
                                target: peer.target,
                                commandId: id,
                            }),
                        );
                    const prompt = (id: string, text: string) =>
                        encodeSessionPromptCommand({
                            attachments: [],
                            requestId: id,
                            commandId: id,
                            requestId: id,
                            disposition: "append",
                            kind: "session.prompt",
                            prompt: text,
                            target: peer.target,
                        });
                    const original = prompt(commandId, "This command was already cancelled");
                    if (admission === "queued") {
                        peer.send(prompt("running-hold", "hold after first delta"));
                        for (;;) {
                            const raw = await peer.nextMessage();
                            if (
                                decodeMessageKind(raw) === "session.event.v2" &&
                                decodeSessionEventEnvelope(raw).events.some(
                                    (event) =>
                                        event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                                )
                            ) {
                                break;
                            }
                        }
                        peer.send(original);
                        for (;;) {
                            const raw = await peer.nextMessage();
                            if (
                                decodeMessageKind(raw) === "session.event.v2" &&
                                decodeSessionEventEnvelope(raw).events.some(
                                    (event) =>
                                        event.type === "lifecycle-metadata" &&
                                        event.payload.kind === "session.queue.changed",
                                )
                            ) {
                                break;
                            }
                        }
                    }
                    cancel(commandId);
                    expect(await observe(peer, [commandId])).toEqual({
                        started: [],
                        failures: [],
                        cancelled: [commandId],
                        output: "",
                    });
                    if (admission === "queued") {
                        peer.send(
                            JSON.stringify({
                                kind: "session.cancel",
                                requestId: crypto.randomUUID(),
                                target: peer.target,
                                commandId: "running-hold",
                            }),
                        );
                        await observe(peer, ["running-hold"]);
                    }
                    const pruners = Array.from(
                        { length: 1026 },
                        (_, index) => `z-prune-${String(index).padStart(4, "0")}`,
                    );
                    for (const id of pruners) {
                        cancel(id);
                    }
                    await observe(peer, pruners);
                    const checkCancelled = async () => {
                        peer.send(original);
                        expect(await observe(peer, [commandId])).toEqual({
                            started: [],
                            output: "",
                            cancelled: [],
                            failures: ["command_identity_conflict"],
                        });
                        cancel(commandId);
                        expect(await observe(peer, [commandId])).toEqual({
                            started: [],
                            failures: [],
                            cancelled: [commandId],
                            output: "",
                        });
                    };
                    await checkCancelled();
                    await peer.restart();
                    await checkCancelled();
                    peer.send(prompt("new-intent", "A new intent still runs"));
                    expect((await observe(peer, ["new-intent"])).output).toContain(
                        `Controlled ACP turn ${admission === "queued" ? 2 : 1}: A new intent still runs`,
                    );
                },
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        }
    }, 90_000);
}
