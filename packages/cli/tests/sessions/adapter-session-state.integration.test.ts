import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeSessionConfigReadCommand,
    encodeSessionConfigureCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { waitForAgentFile } from "../support/agents/observed-process.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";

afterEach(() => vi.useRealTimers());

test("Given a resumed conversation with a configuration edit awaiting the Agent, When its first history load is rejected as busy, Then the edit still commits and survives restart", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
    const directory = await mkdtemp(join(tmpdir(), "morty-configuration-history-"));
    try {
        await withControlledDaemon(
            new UpdatingSettingsAgent("configuration"),
            {
                MORTY_TEST_SESSION_STATE_PATH: process.execPath,
                MORTY_FAKE_ACP_STATE_DIRECTORY: directory,
            },
            async (peer) => {
                const next = async (kind: string): Promise<string> => {
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
                };
                const prepare = async () => {
                    peer.send(
                        encodeSessionPrepareCommand({
                            kind: "session.prepare",
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                        }),
                    );
                    return decodeSessionReadyEvent(await next("session.ready"));
                };
                await prepare();
                const commandId = crypto.randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        requestId: commandId,
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        prompt: "Persist this conversation",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                        throw new Error(JSON.stringify(event.payload));
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === commandId
                    ) {
                        break;
                    }
                }
                await peer.restart();
                const ready = await prepare();
                await writeFile(join(directory, "pause-configuration"), "");
                const paused = waitForAgentFile(join(directory, "configuration-paused"), true);
                const configureId = crypto.randomUUID();
                peer.send(
                    encodeSessionConfigureCommand({
                        kind: "session.configure",
                        requestId: configureId,
                        configId: "model",
                        type: "select",
                        value: "test-large",
                        expectedConfigurationRevision: ready.configurationRevision,
                        target: peer.target,
                    }),
                );
                await paused;
                const historyId = crypto.randomUUID();
                peer.send(
                    encodeSessionHistoryPageLoad({
                        kind: "session.live-history.v2.page.load",
                        requestId: historyId,
                        target: peer.target,
                        cursor: null,
                        eventLimit: 200,
                    }),
                );
                expect(decodeSessionOperationFailedEvent(await next("session.operation.failed"))).toMatchObject({
                    requestId: historyId,
                    code: "session_busy",
                });
                await rm(join(directory, "pause-configuration"));
                const configured = decodeSessionConfigUpdatedEvent(await next("session.config.updated"));
                expect(configured.requestId).toBe(configureId);
                expect(configured.configurationRevision).not.toBe(ready.configurationRevision);
                expect(configured.configOptions).toContainEqual(
                    expect.objectContaining({ id: "model", currentValue: "test-large" }),
                );
                peer.send(
                    encodeSessionConfigReadCommand({
                        kind: "session.config.read",
                        requestId: crypto.randomUUID(),
                        target: peer.target,
                    }),
                );
                const current = decodeSessionConfigReadResult(await next("session.config.read.result"));
                expect(current.configurationRevision).toBe(configured.configurationRevision);
                expect(current.configOptions).toEqual(configured.configOptions);
                await peer.restart();
                expect((await prepare()).configOptions).toContainEqual(
                    expect.objectContaining({ id: "model", currentValue: "test-large" }),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

class UpdatingSettingsAgent extends ControlledAcpSpecification {
    readonly agentExecutable = "node";
    readonly harness = "controlled-acp";
    readonly label = "Controlled session state";
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor(stage: "opening" | "configuration") {
        super("MORTY_TEST_SESSION_STATE_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            stage === "opening"
                ? "--announce-newer-settings-while-creating"
                : "--announce-newer-settings-while-configuring",
        ]);
    }
}

test.each(["opening", "configuration"] as const)(
    "Given an Agent updates settings before its %s response, When the client operation completes, Then the returned settings preserve the newer model, mode, and speed",
    async (stage) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        await withControlledDaemon(
            new UpdatingSettingsAgent(stage),
            { MORTY_TEST_SESSION_STATE_PATH: process.execPath },
            async (peer) => {
                const requestId = crypto.randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        target: peer.target,
                        requestId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (kind !== "session.ready") {
                        continue;
                    }
                    const ready = decodeSessionReadyEvent(message);
                    expect(ready.requestId).toBe(requestId);
                    let configOptions = ready.configOptions;
                    if (stage === "configuration") {
                        const configureId = crypto.randomUUID();
                        peer.send(
                            encodeSessionConfigureCommand({
                                kind: "session.configure",
                                target: peer.target,
                                requestId: configureId,
                                configId: "model",
                                type: "select",
                                value: "test-large",
                                expectedConfigurationRevision: ready.configurationRevision,
                            }),
                        );
                        for (;;) {
                            const message = await peer.nextMessage();
                            const kind = decodeMessageKind(message);
                            if (kind === "session.operation.failed") {
                                throw new Error(message);
                            }
                            if (kind !== "session.config.updated") {
                                continue;
                            }
                            const configured = decodeSessionConfigUpdatedEvent(message);
                            if (configured.requestId === configureId) {
                                configOptions = configured.configOptions;
                                break;
                            }
                        }
                    }
                    expect(configOptions).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ id: "model", currentValue: "test-large" }),
                            expect.objectContaining({ id: "mode", currentValue: "plan" }),
                            expect.objectContaining({ id: "fast_mode", booleanValue: true }),
                        ]),
                    );
                    return;
                }
            },
        );
    },
);
