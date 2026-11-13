import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    encodeNativeSessionRequest,
    encodeSessionPromptCommand,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionTarget,
    SESSION_OPERATION_FAILED_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type DaemonConnectionPeer, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const prompt = (peer: DaemonConnectionPeer, target: NativeSessionTarget, commandId: string, text: string): void =>
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            requestId: commandId,
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            kind: "session.prompt",
            prompt: text,
            target,
        }),
    );

const readExecution = (peer: DaemonConnectionPeer, target: NativeSessionTarget, requestId: string): void =>
    peer.send(
        encodeNativeSessionRequest({
            action: "active-turn",
            kind: "native.session.request",
            requestId,
            target,
        }),
    );

/** The Computer's answer to `requestId`: the execution it read, or the failure it refused the request with. */
const answer = async (peer: DaemonConnectionPeer, requestId: string) => {
    for (;;) {
        const raw = await peer.nextMessage();
        const kind = decodeMessageKind(raw);
        if (kind === NATIVE_SESSION_RESULT_KIND) {
            const result = decodeNativeSessionResult(raw);
            if (result.requestId === requestId) {
                return result;
            }
        }
        if (kind === SESSION_OPERATION_FAILED_KIND) {
            const failure = decodeSessionOperationFailedEvent(raw);
            if (failure.requestId === requestId) {
                return failure;
            }
        }
    }
};

const withAgent = async (scenario: (peer: RealDaemonPeer) => Promise<void>): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), "morty-session-target-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            scenario,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

test("Given a Session whose prompt is running, When a client prompts it and reads its execution naming only the Session, Then the Computer runs the prompt in the Session's own Agent and directory and reports the running turn", async () => {
    await withAgent(async (peer) => {
        const commandId = randomUUID();
        prompt(peer, peer.target, commandId, "hold after first delta");
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.started" &&
                event.payload.commandId === commandId
            ) {
                break;
            }
        }

        const requestId = randomUUID();
        readExecution(peer, peer.target, requestId);

        expect(await answer(peer, requestId)).toMatchObject({
            action: "active-turn",
            target: peer.target,
            turn: { commandId, state: "running" },
            queued: [],
        });
    });
}, 90_000);

test("Given a native Session the Computer does not hold, When a client prompts it or reads its execution, Then the Computer refuses both as session_not_found", async () => {
    await withAgent(async (peer) => {
        const unknown = { harness: peer.target.harness, sessionId: randomUUID() };
        const commandId = randomUUID();
        prompt(peer, unknown, commandId, "This Session does not exist");
        expect(await answer(peer, commandId)).toMatchObject({
            code: "session_not_found",
            kind: SESSION_OPERATION_FAILED_KIND,
            target: unknown,
        });

        const requestId = randomUUID();
        readExecution(peer, unknown, requestId);
        expect(await answer(peer, requestId)).toMatchObject({
            code: "session_not_found",
            kind: SESSION_OPERATION_FAILED_KIND,
        });
    });
}, 90_000);
