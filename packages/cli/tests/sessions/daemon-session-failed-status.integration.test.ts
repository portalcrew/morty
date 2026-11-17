import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameNativeSession } from "@portalcrew/morty-client/native-session";
import {
    decodeMessageKind,
    decodeSessionsQueriedEvent,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    type SessionStatus,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import {
    nextPromptSettlement,
    prepareNewRealSession,
    type RealDaemonPeer,
    withControlledDaemon,
} from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], commandId: string, prompt: string) =>
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: "append",
            kind: "session.prompt",
            prompt,
            target: sessionTarget,
        }),
    );

async function queriedStatus(
    peer: RealDaemonPeer,
    sessionTarget: RealDaemonPeer["target"],
): Promise<SessionStatus | undefined> {
    const requestId = randomUUID();
    peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId, targets: [sessionTarget] }));
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) === "session.queried") {
            const queried = decodeSessionsQueriedEvent(message);
            if (queried.requestId === requestId) {
                return queried.entries.find((entry) => sameNativeSession(entry.target, sessionTarget))?.status;
            }
        }
    }
}

test("Given a Session whose last turn failed, When a client that did not watch it reads its status, Then the Session reports that failure until another turn completes, and then reports that turn", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "failed-status-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory, { loadSession: true });
        await withControlledDaemon(
            signal,
            new ControlledAcpAgentSpecification(),
            { MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const failed = randomUUID();
                const sessionTarget = await prepareNewRealSession(peer, "controlled-acp");
                submit(peer, sessionTarget, failed, "fail with model unavailable");
                const failure = {
                    code: "acp_agent_error",
                    commandId: failed,
                    message: expect.any(String),
                    state: "failed",
                };
                await nextPromptSettlement(peer, failed);
                expect(await queriedStatus(peer, sessionTarget)).toEqual({ kind: "idle", lastTurn: failure });

                await peer.restart();
                expect(await queriedStatus(peer, sessionTarget)).toEqual({ kind: "idle", lastTurn: failure });

                const completed = randomUUID();
                submit(peer, sessionTarget, completed, "The request completes");
                await nextPromptSettlement(peer, completed);
                expect(await queriedStatus(peer, sessionTarget)).toEqual({
                    kind: "idle",
                    lastTurn: { commandId: completed, state: "completed", stopReason: "end_turn" },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
