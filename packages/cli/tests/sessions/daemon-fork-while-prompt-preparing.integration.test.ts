import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";
import { fileCreated } from "../support/file-created.ts";

async function promptOutcome(peer: RealDaemonPeer, commandId: string): Promise<"completed" | "failed"> {
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "lifecycle-metadata" &&
            "commandId" in event.payload &&
            event.payload.commandId === commandId &&
            (event.payload.kind === "prompt.completed" || event.payload.kind === "prompt.failed")
        ) {
            return event.payload.kind === "prompt.completed" ? "completed" : "failed";
        }
    }
}

test("Given a prompt accepted while the Agent applies its settings and has not begun the turn, When the Session is forked, Then the fork is refused as busy and the prompt completes", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-fork-while-preparing-"));
    try {
        const agentDirectory = join(directory, "agent");
        await mkdir(agentDirectory, { recursive: true });
        const executableDirectory = await writeControlledAcpExecutable(directory, { forkSession: true });
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: agentDirectory, PATH: executableDirectory },
            async (peer) => {
                const submit = (commandId: string, prompt: string, fast: boolean): void =>
                    peer.send(
                        encodeSessionPromptCommand({
                            attachments: [],
                            commandId,
                            requestId: commandId,
                            disposition: SessionPromptDisposition.Append,
                            kind: "session.prompt",
                            prompt,
                            sessionConfigurations: [{ booleanValue: fast, configId: "fast_mode", type: "boolean" }],
                            target: peer.target,
                        }),
                    );
                const seed = randomUUID();
                submit(seed, "Give the conversation some history", false);
                expect(await promptOutcome(peer, seed)).toBe("completed");

                await writeFile(join(agentDirectory, "pause-configuration"), "");
                const applying = fileCreated(agentDirectory, "configuration-paused");
                const next = randomUUID();
                submit(next, "Continue with fast mode on", true);
                await applying;

                const forkRequest = randomUUID();
                peer.send(
                    encodeNativeSessionCommand({
                        kind: "native.session.request",
                        action: "fork",
                        requestId: forkRequest,
                        harness: peer.target.harness,
                        directory: ".",
                        sessionId: peer.target.sessionId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        expect(decodeSessionOperationFailedEvent(message)).toMatchObject({
                            requestId: forkRequest,
                            code: "session_busy",
                        });
                        break;
                    }
                    expect(kind).not.toBe("native.session.result");
                }

                await rm(join(agentDirectory, "pause-configuration"));
                expect(await promptOutcome(peer, next)).toBe("completed");
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
