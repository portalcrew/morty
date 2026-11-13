import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionCommand,
    encodeSessionConfigReadCommand,
    encodeSessionConfigureCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRenameCommand,
    encodeSessionRestoreCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { ControlledReadinessSpecification } from "../support/agents/controlled-readiness-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import { waitForAgentFile } from "../support/agents/observed-process.ts";
import { type RealDaemonPeer, withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";
import { IdleTimeoutTimer } from "../support/idle-timeout-timer.ts";

class IdleAgentSpecification extends ControlledAcpSpecification {
    readonly agentExecutable = "controlled-acp";
    readonly harness = "claude";
    readonly label = "Controlled ACP";
    override readonly minimumSupportedAgentVersion = "1.0.0";

    constructor() {
        super("MORTY_TEST_CONTROLLED_ACP_PATH", []);
    }
}

const twoHours = 2 * 60 * 60 * 1_000;
const peerUrl = new URL("./fixtures/acp-peer.ts", import.meta.url).href;

// Failure modes: no reclamation below capacity; early reclamation; old deadlines surviving
// activity; busy turns/history being interrupted; native identity/history being lost;
// query processes leaking; old close/shutdown deadlines affecting replacement processes.
// All scenarios enter through the public daemon protocol and observe real subprocess files.

afterEach(() => vi.useRealTimers());

async function withIdleDaemon(
    recovery: "resume" | "load",
    scenario: (peer: RealDaemonPeer, native: string, timer: IdleTimeoutTimer) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "morty-idle-process-"));
    const native = join(directory, "native");
    const executable = join(directory, "controlled-acp");
    await mkdir(native);
    await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv.includes("--version")) {
    process.stdout.write("1.0.0\\n");
} else {
    process.env.MORTY_FAKE_ACP_PROCESS_ID = String(process.pid);
    process.argv.push("--agent-name", "Controlled ACP", "--exclusive-writer", "--http-mcp",
        "--no-delete-session", "--no-fork-session", "--no-embedded-context"
        ${recovery === "load" ? ', "--load-only"' : ""});
    await import(${JSON.stringify(peerUrl)});
}
`,
        { mode: 0o700 },
    );
    vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
    try {
        const timer = new IdleTimeoutTimer();
        await withRealDaemon(
            new IdleAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: native,
                MORTY_FAKE_ACP_PROCESS_DIRECTORY: native,
                MORTY_FAKE_ACP_FAIL_HISTORY_LOAD: "0",
                MORTY_TEST_CONTROLLED_ACP_PATH: executable,
            },
            async (peer) => await scenario(peer, native, timer),
            "embedded",
            undefined,
            timer,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function processId(native: string): Promise<string> {
    const writers = (await readdir(native)).filter((file) => file.endsWith(".writer"));
    expect(writers).toHaveLength(1);
    const writer = writers[0];
    if (writer === undefined) {
        throw new Error("The Agent has no native Session writer");
    }
    return await readFile(join(native, writer), "utf8");
}

async function expire(native: string, pid: string, timer: IdleTimeoutTimer): Promise<void> {
    const exit = waitForAgentFile(join(native, `${pid}.process`), false);
    timer.advance(1);
    await exit;
}

function sendPrompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], prompt: string): void {
    peer.send(
        encodeSessionPromptCommand({
            commandId: crypto.randomUUID(),
            disposition: SessionPromptDisposition.Append,
            attachments: [],
            kind: "session.prompt",
            prompt,
            target: sessionTarget,
        }),
    );
}

async function readTurn(peer: RealDaemonPeer): Promise<string> {
    let text = "";
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            text += event.payload.content.text;
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.stopReason).toBe("end_turn");
            return text;
        }
    }
}

async function prompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], text: string): Promise<string> {
    sendPrompt(peer, sessionTarget, text);
    return await readTurn(peer);
}

async function nextResponse(peer: RealDaemonPeer, kind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const received = decodeMessageKind(message);
        expect(received).not.toBe("session.close.notice");
        if (received === "session.operation.failed") {
            throw new Error(message);
        }
        if (received === kind) {
            return message;
        }
    }
}

test.each(["resume", "load"] as const)(
    "Given a retained %s conversation below capacity, When it is idle for two hours, Then its process exits and the same native conversation continues",
    async (recovery) => {
        await withIdleDaemon(recovery, async (peer, native, timer) => {
            const sessionTarget = peer.target;
            expect(await prompt(peer, sessionTarget, "Remember the first turn")).toContain("turn 1:");
            const original = await processId(native);
            timer.advance(twoHours - 1);
            expect(await processId(native)).toBe(original);
            await expire(native, original, timer);
            expect((await readdir(native)).filter((file) => file.endsWith(".writer"))).toEqual([]);
            expect(await prompt(peer, sessionTarget, "Continue after idle reclamation")).toContain("turn 2:");
            expect(await processId(native)).not.toBe(original);
            peer.send(
                encodeSessionHistoryPageLoad({
                    kind: "session.live-history.v2.page.load",
                    requestId: crypto.randomUUID(),
                    target: sessionTarget,
                    cursor: null,
                    eventLimit: 200,
                }),
            );
            const history = await nextResponse(peer, "session.live-history.v2.page.loaded");
            expect(history).toContain("Remember the first turn");
            expect(history).toContain("Continue after idle reclamation");
        });
    },
);

test.each(["resume", "load"] as const)(
    "Given a reclaimed %s conversation, When an existing client renames it, Then both directories retain the new title after continuing",
    async (recovery) => {
        await withIdleDaemon(recovery, async (peer, native, timer) => {
            const sessionTarget = peer.target;
            await prompt(peer, sessionTarget, "Original native title");
            const original = await processId(native);
            timer.advance(twoHours - 1);
            await expire(native, original, timer);

            // Exercise the native-pair request independently of the current encoder.
            peer.send(
                JSON.stringify({
                    kind: "session.rename",
                    requestId: crypto.randomUUID(),
                    target: sessionTarget,
                    title: "Renamed after reclamation",
                }),
            );
            await nextResponse(peer, "session.renamed");

            const expectTitles = async (): Promise<void> => {
                peer.send(
                    encodeSessionQueryCommand({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        targets: [sessionTarget],
                    }),
                );
                expect(decodeSessionsQueriedEvent(await nextResponse(peer, "session.queried")).entries).toEqual([
                    expect.objectContaining({ target: sessionTarget, title: "Renamed after reclamation" }),
                ]);
                peer.send(
                    encodeNativeSessionCommand({
                        kind: "native.session.request",
                        action: "list",
                        requestId: crypto.randomUUID(),
                        harness: "claude",
                        directory: ".",
                        cursor: null,
                    }),
                );
                const directory = decodeNativeSessionResult(await nextResponse(peer, "native.session.result"));
                if (directory.action !== "list") {
                    throw new Error("Expected the native directory");
                }
                expect(directory.entries.find((entry) => entry.sessionId === sessionTarget.sessionId)?.title).toBe(
                    "Renamed after reclamation",
                );
            };

            await expectTitles();
            expect(await prompt(peer, sessionTarget, "Continue the renamed conversation")).toContain("turn 2:");
            await expectTitles();
        });
    },
);

test("Given a client read a conversation's settings before its idle process exited, When it changes a setting with the revision it read, Then the change applies", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        expect(await prompt(peer, sessionTarget, "Remember the first turn")).toContain("turn 1:");
        const readId = crypto.randomUUID();
        peer.send(
            encodeSessionConfigReadCommand({ kind: "session.config.read", requestId: readId, target: sessionTarget }),
        );
        const read = decodeSessionConfigReadResult(await nextResponse(peer, "session.config.read.result"));
        expect(read.requestId).toBe(readId);
        const model = read.configOptions.find((option) => option.id === "model");
        const other =
            model?.type === "select"
                ? model.values.find((value) => value.value !== model.currentValue)?.value
                : undefined;
        if (other === undefined) {
            throw new Error("The controlled Agent must offer a second model");
        }
        const original = await processId(native);
        timer.advance(twoHours - 1);
        await expire(native, original, timer);

        const configureId = crypto.randomUUID();
        peer.send(
            encodeSessionConfigureCommand({
                configId: "model",
                expectedConfigurationRevision: read.configurationRevision,
                kind: "session.configure",
                requestId: configureId,
                target: sessionTarget,
                value: other,
                type: "select",
            }),
        );
        for (;;) {
            const updated = decodeSessionConfigUpdatedEvent(await nextResponse(peer, "session.config.updated"));
            if (updated.requestId !== configureId) {
                continue;
            }
            expect(updated.configOptions.find((option) => option.id === "model")).toMatchObject({
                currentValue: other,
            });
            expect(updated.configurationRevision).not.toBe(read.configurationRevision);
            break;
        }
    });
});

test("Given a retained conversation is used again, When its original idle deadline passes, Then it stays alive until two hours after the latest turn", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        await prompt(peer, sessionTarget, "First turn");
        const original = await processId(native);
        timer.advance(twoHours / 2);
        await prompt(peer, sessionTarget, "Refresh the idle deadline");
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a turn lasts longer than the idle timeout, When three hours pass, Then it completes in the same process and receives a full idle window afterwards", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        const original = await processId(native);
        timer.advance(twoHours / 2);
        const paused = waitForAgentFile(join(native, "prompt-paused"), true);
        sendPrompt(peer, sessionTarget, "release before first delta");
        await paused;
        timer.advance(3 * 60 * 60 * 1_000);
        expect(await processId(native)).toBe(original);
        await writeFile(join(native, "resume-turn"), "");
        expect(await readTurn(peer)).toContain("turn 1:");
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a retained native session browser, When two idle hours pass, Then its process exits and browsing can start again", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        await prompt(peer, sessionTarget, "Persist a listed conversation");
        const execution = await processId(native);
        const browse = async (): Promise<string> => {
            peer.send(
                encodeNativeSessionCommand({
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    harness: "claude",
                    directory: ".",
                    action: "list",
                    cursor: null,
                }),
            );
            return await nextResponse(peer, "native.session.result");
        };
        expect(await browse()).toContain(sessionTarget.sessionId);
        const processes = (await readdir(native)).filter((file) => file.endsWith(".process"));
        expect(processes).toHaveLength(2);
        timer.advance(twoHours - 1);
        const exits = processes.map((file) => waitForAgentFile(join(native, file), false));
        timer.advance(1);
        await Promise.all(exits);
        expect(existsSync(join(native, `${execution}.process`))).toBe(false);
        expect(await browse()).toContain(sessionTarget.sessionId);
    });
});

test("Given an old retained process and a daemon restart, When its deadline passes, Then a newly prepared process gets its own full idle window", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        await prompt(peer, sessionTarget, "Before restart");
        timer.advance(twoHours / 2);
        await peer.restart();
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                target: sessionTarget,
            }),
        );
        expect(decodeSessionReadyEvent(await nextResponse(peer, "session.ready")).target).toEqual(sessionTarget);
        const replacement = await processId(native);
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(replacement);
        await expire(native, replacement, timer);
    });
});

test("Given native history is loading in a retained process, When three hours pass, Then the load completes and a new idle window starts", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        await prompt(peer, sessionTarget, "History before a long load");
        // A restarted daemon starts the Session in a new process.
        await peer.restart();
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                target: sessionTarget,
            }),
        );
        await nextResponse(peer, "session.ready");
        const original = await processId(native);
        peer.send(
            encodeSessionQueryCommand({
                kind: "session.query",
                requestId: crypto.randomUUID(),
                targets: [sessionTarget],
            }),
        );
        const [entry] = decodeSessionsQueriedEvent(await nextResponse(peer, "session.queried")).entries;
        if (entry === undefined) {
            throw new Error("Missing persisted native identity");
        }
        await writeFile(join(native, "pause-load"), "*");
        const paused = waitForAgentFile(join(native, "load-paused"), true);
        peer.send(
            encodeSessionRestoreCommand({
                kind: "session.restore",
                requestId: crypto.randomUUID(),
                target: { harness: entry.harness, sessionId: entry.sessionId },
            }),
        );
        const restored = nextResponse(peer, "session.restored");
        await Promise.race([
            paused,
            restored.then((response) => {
                throw new Error(`History completed before the controlled load was released: ${response}`);
            }),
        ]);
        timer.advance(3 * 60 * 60 * 1_000);
        expect(await processId(native)).toBe(original);
        await rm(join(native, "pause-load"));
        await restored;
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a canonical native Session is idle, When its process is reclaimed, Then it stays queryable before any process is restarted", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionTarget = peer.target;
        await prompt(peer, sessionTarget, "Native title before idle");
        peer.send(
            encodeSessionRenameCommand({
                kind: "session.rename",
                requestId: crypto.randomUUID(),
                target: sessionTarget,
                title: "Native title before idle",
            }),
        );
        await nextResponse(peer, "session.renamed");
        const original = await processId(native);
        timer.advance(twoHours - 1);
        await expire(native, original, timer);
        peer.send(
            encodeSessionQueryCommand({
                kind: "session.query",
                requestId: crypto.randomUUID(),
                targets: [sessionTarget],
            }),
        );
        expect(decodeSessionsQueriedEvent(await nextResponse(peer, "session.queried")).entries).toEqual([
            expect.objectContaining({ target: sessionTarget, title: "Native title before idle", prompted: true }),
        ]);
        expect((await readdir(native)).filter((file) => file.endsWith(".process"))).toEqual([]);
        expect(await prompt(peer, sessionTarget, "Continue the canonical Session")).toContain("turn 2:");
    });
});

class RetiringIdleAgentSpecification extends ControlledReadinessSpecification {
    readonly agentExecutable = "node";
    readonly harness = "claude";
    readonly label = "Controlled retiring Agent";
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createConnection = this.sessions.createConnection;

    constructor() {
        super("MORTY_TEST_RETIRING_IDLE_PATH");
    }
}

test("Given idle process teardown is still releasing the native writer, When a new prompt arrives, Then it waits before starting a replacement process", async () => {
    const specification = new RetiringIdleAgentSpecification();
    const timer = new IdleTimeoutTimer();
    vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
    await withRealDaemon(
        specification,
        { MORTY_TEST_RETIRING_IDLE_PATH: process.execPath },
        async (peer) => {
            try {
                const sessionTarget = peer.target;
                await prompt(peer, sessionTarget, "Before idle retirement");
                const endpointsBeforeRetirement = specification.sessions.endpointCount();
                const held = specification.sessions.closes.hold();
                timer.advance(twoHours);
                await held.entered;
                sendPrompt(peer, sessionTarget, "After idle retirement");
                peer.send(
                    encodeSessionQueryCommand({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        targets: [sessionTarget],
                    }),
                );
                await nextResponse(peer, "session.queried");
                // Neither discovery nor a replacement writer may start before teardown finishes.
                expect(specification.sessions.endpointCount()).toBe(endpointsBeforeRetirement);
                held.release();
                await readTurn(peer);
                // Recovery starts one capability reader and one replacement execution process.
                expect(specification.sessions.endpointCount()).toBe(endpointsBeforeRetirement + 2);
            } finally {
                specification.sessions.releaseAll();
            }
        },
        "embedded",
        undefined,
        timer,
    );
});
