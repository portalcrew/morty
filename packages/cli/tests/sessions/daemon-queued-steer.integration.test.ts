import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptSteeredEvent,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_PROMPT_DISPOSITION_KIND,
    type SessionLiveEvent,
    type SessionOperationFailedEvent,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, prompt: string) => {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: "append",
            kind: "session.prompt",
            prompt,
            target: peer.target,
        }),
    );
    return commandId;
};

/** Sends a steer and returns the identifier its reply names. */
const steer = (peer: RealDaemonPeer, commandId: string, sessionTarget = peer.target): string => {
    const requestId = randomUUID();
    peer.send(
        encodeSessionPromptDispositionCommand({
            kind: SESSION_PROMPT_DISPOSITION_KIND,
            requestId,
            commandId,
            target: sessionTarget,
            disposition: SessionPromptDisposition.Steer,
        }),
    );
    return requestId;
};

const cancel = (peer: RealDaemonPeer, commandId: string) =>
    peer.send(JSON.stringify({ kind: "session.cancel", requestId: randomUUID(), commandId, target: peer.target }));

const observe = (peer: RealDaemonPeer) => {
    const events: SessionLiveEvent[] = [];
    const failures: SessionOperationFailedEvent[] = [];
    const steered: string[] = [];
    const next = async () => {
        const raw = await peer.nextMessage();
        switch (decodeMessageKind(raw)) {
            case "session.prompt.steered":
                steered.push(decodeSessionPromptSteeredEvent(raw).requestId);
                break;
            case "session.event.v2":
                events.push(...decodeSessionEventEnvelope(raw).events);
                break;
            case "session.operation.failed":
                failures.push(decodeSessionOperationFailedEvent(raw));
                break;
        }
    };
    return {
        events,
        failures,
        steered,
        until: async (ready: () => boolean) => {
            while (!ready()) {
                await next();
            }
        },
        lifecycle: async (kind: string, commandId?: string) => {
            while (
                !events.some(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === kind &&
                        (commandId === undefined ||
                            ("commandId" in event.payload && event.payload.commandId === commandId)),
                )
            ) {
                await next();
            }
        },
    };
};

const scenario = async (run: (peer: RealDaemonPeer) => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-queued-steer-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            run,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
};

test("Given queued work has started or completed, When a client sends a late steer, Then it receives the actual state without executing the message again", async () => {
    await scenario(async (peer) => {
        const observed = observe(peer);
        const running = submit(peer, "hold after first delta");
        await observed.lifecycle("prompt.started", running);
        const queued = submit(peer, "hold after first delta");
        await observed.lifecycle("session.queue.changed");
        cancel(peer, running);
        await observed.lifecycle("prompt.started", queued);
        const lateSteer = steer(peer, queued);
        await observed.until(() => observed.failures.length === 1);
        expect(observed.failures[0]).toMatchObject({
            requestId: lateSteer,
            target: peer.target,
            code: "turn_already_started",
        });
        cancel(peer, queued);
        await observed.lifecycle("prompt.completed", queued);
        const settledSteer = steer(peer, queued);
        const foreignTarget = { harness: peer.target.harness, sessionId: "another-session" };
        const foreignSteer = steer(peer, queued, foreignTarget);
        await observed.until(() => observed.failures.length === 3);
        expect(observed.failures.slice(1)).toMatchObject([
            { requestId: settledSteer, target: peer.target, code: "turn_already_started" },
            { requestId: foreignSteer, target: foreignTarget, code: "turn_not_active" },
        ]);
        expect(
            observed.events.filter(
                (event) =>
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.started" &&
                    event.payload.commandId === queued,
            ),
        ).toHaveLength(1);
        const diagnostics = await peer.readDiagnostics();
        expect(diagnostics).toContain('"event":"session_prompt_disposition_failed"');
        expect(diagnostics).toContain(`"commandId":"${queued}"`);
        expect(diagnostics).not.toContain("hold after first delta");
    });
});

test("Given a queued instruction, When two clients request steering together, Then the instruction is delivered once and any late refusal identifies its state", async () => {
    await scenario(async (peer) => {
        const observed = observe(peer);
        const running = submit(peer, "wait for steering");
        await observed.until(() =>
            observed.events.some(
                (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
            ),
        );
        const instruction = "Apply the queued instruction once";
        const queued = submit(peer, instruction);
        await observed.lifecycle("session.queue.changed");
        steer(peer, queued);
        steer(peer, queued);
        await observed.lifecycle("prompt.completed", queued);
        await observed.lifecycle("prompt.completed", running);
        const retry = steer(peer, queued);
        await observed.until(
            () => observed.steered.includes(retry) || observed.failures.some((failure) => failure.requestId === retry),
        );
        expect(observed.steered).toContain(retry);
        expect(observed.failures.every((failure) => failure.code === "turn_already_started")).toBe(true);
        expect(
            observed.events.filter(
                (event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text" &&
                    event.payload.content.text === instruction,
            ),
        ).toHaveLength(1);
        expect(observed.events).toContainEqual(
            expect.objectContaining({
                type: "acp",
                payload: expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Steered: ${instruction}` },
                }),
            }),
        );
    });
});
