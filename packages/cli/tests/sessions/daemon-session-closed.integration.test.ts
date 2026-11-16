import {
    decodeMessageKind,
    decodeSessionArchivedEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionConfigReadResult,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptAcceptedEvent,
    decodeSessionRenamedEvent,
    decodeSessionsQueriedEvent,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    SESSION_CLOSED_ERROR_CODE,
    type SessionOperationFailedEvent,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { encodeSessionArchiveCommand } from "../../../client/src/protocol/session/lifecycle/index.ts";
import type { AgentConnectionFactory } from "../support/agents/agent-connection.ts";
import { ControlledReadinessSpecification } from "../support/agents/controlled-readiness-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import {
    nextPromptSettlement,
    prepareNewRealSession,
    type RealDaemonPeer,
    withControlledDaemon as withRealDaemon,
} from "../support/agents/real-daemon.ts";

const NATIVE_HARNESS = "claude";

class ClosableAgentSpecification extends ControlledReadinessSpecification {
    readonly agentExecutable = "node";
    readonly harness = NATIVE_HARNESS;
    readonly label = "Controlled Claude";
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createConnection: AgentConnectionFactory = this.sessions.createConnection;

    constructor() {
        super("MORTY_TEST_CONTROLLED_CLOSABLE_PATH");
    }
}

async function withClosableDaemon(
    signal: AbortSignal,
    specification: ClosableAgentSpecification,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
): Promise<void> {
    await withRealDaemon(
        signal,
        specification,
        { MORTY_TEST_CONTROLLED_CLOSABLE_PATH: process.execPath },
        async (peer) => {
            try {
                await scenario(peer);
            } finally {
                // A scenario that fails while a teardown is held must not keep the daemon from stopping.
                specification.sessions.releaseAll();
            }
        },
    );
}

async function nextMessageOfKind(peer: RealDaemonPeer, kind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const received = decodeMessageKind(message);
        if (received === kind) {
            return message;
        }
        if (received === "session.operation.failed") {
            throw new Error(message);
        }
    }
}

async function nextFailure(peer: RealDaemonPeer, requestId: string): Promise<SessionOperationFailedEvent> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.prompt.accepted" && decodeSessionPromptAcceptedEvent(message).requestId === requestId) {
            throw new Error("The prompt was accepted instead of failing");
        }
        if (kind === "session.renamed" && decodeSessionRenamedEvent(message).requestId === requestId) {
            throw new Error("The rename succeeded instead of failing");
        }
        if (kind === "session.config.read.result" && decodeSessionConfigReadResult(message).requestId === requestId) {
            throw new Error("The settings read succeeded instead of failing");
        }
        if (kind !== "session.operation.failed") {
            continue;
        }
        const failure = decodeSessionOperationFailedEvent(message);
        if (failure.requestId === requestId) {
            return failure;
        }
    }
}

function sendPrompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], prompt: string): string {
    const commandId = crypto.randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            attachments: [],
            kind: "session.prompt",
            prompt,
            target: sessionTarget,
        }),
    );
    return commandId;
}

async function prompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], text: string): Promise<void> {
    await nextPromptSettlement(peer, sendPrompt(peer, sessionTarget, text));
}

function sendArchive(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"]): string {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionArchiveCommand({ kind: "session.archive", requestId, target: sessionTarget }));
    return requestId;
}

test("Given a client archives a Session, When the Computer stops its Agent process, Then the Computer announces the closing and why before it answers the archive request", async ({
    signal,
}) => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(signal, specification, async (peer) => {
        const sessionTarget = await prepareNewRealSession(peer, NATIVE_HARNESS);
        const endpointsBeforeClose = specification.sessions.endpointCount();
        const requestId = sendArchive(peer, sessionTarget);

        const announcements: string[] = [];
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.close.notice") {
                expect(decodeSessionCloseNoticeEvent(message)).toEqual({
                    kind,
                    reason: "This Session was archived.",
                    target: sessionTarget,
                });
                announcements.push(kind);
            }
            if (kind === "session.archived") {
                expect(decodeSessionArchivedEvent(message)).toEqual({ kind, requestId, target: sessionTarget });
                announcements.push(kind);
                break;
            }
        }

        expect(announcements).toEqual(["session.close.notice", "session.archived"]);
        expect(specification.sessions.operations.at(-1)).toEqual({
            endpoint: endpointsBeforeClose - 1,
            method: "session/close",
            sessionId: sessionTarget.sessionId,
        });
        expect(specification.sessions.endpointCount()).toBe(endpointsBeforeClose);
    });
});

test("Given a Session whose Agent process is still stopping, When a client sends a prompt, Then the Computer reports session_closed without waiting for the process", async ({
    signal,
}) => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(signal, specification, async (peer) => {
        const sessionTarget = await prepareNewRealSession(peer, NATIVE_HARNESS);
        const teardown = specification.sessions.closes.hold();
        sendArchive(peer, sessionTarget);
        await teardown.entered;
        const endpointsBeforePrompt = specification.sessions.endpointCount();

        const commandId = sendPrompt(peer, sessionTarget, "Too late");

        expect(await nextFailure(peer, commandId)).toMatchObject({
            code: SESSION_CLOSED_ERROR_CODE,
            target: sessionTarget,
        });
        expect(specification.sessions.endpointCount()).toBe(endpointsBeforePrompt);
        teardown.release();
        await nextMessageOfKind(peer, "session.archived");
    });
});

test.for([
    { prompt: "Plan the release", title: "Plan the release" },
    { prompt: "\n> ## Plan   the release\nAdditional instructions", title: "Plan the release" },
    { prompt: `# ${"\u{1f680}".repeat(45)}\nAdditional instructions`, title: `${"\u{1f680}".repeat(41)}\u2026` },
])(
    "Given a first prompt $prompt, When a client continues the Session, Then its readable fallback title survives",
    async ({ prompt: firstPrompt, title }, { signal }) => {
        const specification = new ClosableAgentSpecification();
        await withClosableDaemon(signal, specification, async (peer) => {
            const sessionTarget = await prepareNewRealSession(peer, NATIVE_HARNESS);
            await prompt(peer, sessionTarget, firstPrompt);

            const queryTitle = async (): Promise<void> => {
                const requestId = crypto.randomUUID();
                peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId, targets: [sessionTarget] }));
                const queried = decodeSessionsQueriedEvent(await nextMessageOfKind(peer, "session.queried"));
                expect(queried.entries).toEqual([
                    expect.objectContaining({ prompted: true, target: sessionTarget, title }),
                ]);
            };
            await queryTitle();
            await prompt(peer, sessionTarget, "Continue with a different request");
            await queryTitle();
        });
    },
);
