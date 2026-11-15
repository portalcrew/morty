import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionReadyEvent,
    decodeSessionsQueriedEvent,
    encodeSessionCreateCommand,
    encodeSessionQueryCommand,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import type { AgentConnectionFactory } from "../support/agents/agent-connection.ts";
import { ControlledReadinessSpecification } from "../support/agents/controlled-readiness-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

const NATIVE_HARNESS = "claude";

class ControlledAgentSpecification extends ControlledReadinessSpecification {
    readonly agentExecutable = "node";
    readonly harness = NATIVE_HARNESS;
    readonly label = "Controlled Claude";
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createConnection: AgentConnectionFactory = this.sessions.createConnection;

    constructor() {
        super("MORTY_TEST_CONTROLLED_QUERY_PATH");
    }
}

/** The message that answers `requestId`, which must be of `kind` rather than a failure. */
async function reply(peer: RealDaemonPeer, kind: string, requestId: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const answered: unknown = JSON.parse(message);
        if (typeof answered === "object" && answered !== null && "requestId" in answered) {
            if (answered.requestId === requestId) {
                expect(decodeMessageKind(message)).toBe(kind);
                return message;
            }
        }
    }
}

async function createSession(peer: RealDaemonPeer, directory: string): Promise<RealDaemonPeer["target"]> {
    const requestId = crypto.randomUUID();
    peer.send(
        encodeSessionCreateCommand({
            harness: NATIVE_HARNESS,
            directory,
            kind: "session.create",
            requestId,
            operationId: crypto.randomUUID(),
            configurations: [],
        }),
    );
    return decodeSessionReadyEvent(await reply(peer, "session.ready", requestId)).target;
}

test("Given a Session whose directory was deleted, When a client queries it with other Sessions, Then every Session is described with its recorded directory", async ({
    signal,
}) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-session-query-")));
    const deleted = join(root, "deleted-project");
    await mkdir(deleted);
    const deletedDirectory = deleted;
    const specification = new ControlledAgentSpecification();
    try {
        await withControlledDaemon(
            signal,
            specification,
            { MORTY_TEST_CONTROLLED_QUERY_PATH: process.execPath },
            async (peer) => {
                const kept = await createSession(peer, ".");
                const orphaned = await createSession(peer, deletedDirectory);
                await rm(deleted, { recursive: true, force: true });

                const requestId = crypto.randomUUID();
                peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId, targets: [kept, orphaned] }));
                const { entries } = decodeSessionsQueriedEvent(await reply(peer, "session.queried", requestId));

                expect(entries.map((entry) => entry.target)).toEqual(expect.arrayContaining([kept, orphaned]));
                expect(entries.find((entry) => entry.target.sessionId === orphaned.sessionId)?.directory).toBe(
                    deletedDirectory,
                );
            },
        );
    } finally {
        specification.sessions.releaseAll();
        await rm(root, { recursive: true, force: true });
    }
});
