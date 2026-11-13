import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

class ForkSettingsAgent extends ControlledAcpSpecification {
    readonly agentExecutable = "node";
    readonly harness = "controlled-acp";
    readonly label = "Controlled Fork settings";
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor(fault: string) {
        super("MORTY_TEST_FORK_SETTINGS_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            "--reset-fork-settings",
            ...(fault.length === 0 ? [] : [fault]),
        ]);
    }
}

test.each(["", "--fork-mode-unavailable", "--fork-omits-mode", "--fork-omits-model", "--model-dependent-mode"])(
    "Given source selections and a Fork Agent %s, When a retained client forks, Then settings are inherited or the Fork fails without changing its source",
    async (fault) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-fork-settings-"));
        try {
            await withControlledDaemon(
                new ForkSettingsAgent(fault),
                {
                    MORTY_TEST_FORK_SETTINGS_PATH: process.execPath,
                    MORTY_FAKE_ACP_STATE_DIRECTORY: directory,
                },
                async (peer) => {
                    const identity = {
                        harness: "controlled-acp",
                        directory: ".",
                    };
                    const configureSource = async (
                        sessionConfigurations: NonNullable<
                            Parameters<typeof encodeSessionPromptCommand>[0]["sessionConfigurations"]
                        >,
                    ): Promise<void> => {
                        peer.send(
                            encodeSessionPromptCommand({
                                kind: "session.prompt",
                                target: peer.target,
                                commandId: crypto.randomUUID(),
                                prompt: "Keep these source settings",
                                attachments: [],
                                disposition: SessionPromptDisposition.Append,
                                sessionConfigurations,
                            }),
                        );
                        for (;;) {
                            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                                throw new Error(JSON.stringify(event));
                            }
                            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                                return;
                            }
                        }
                    };
                    if (fault === "--model-dependent-mode") {
                        await configureSource([{ configId: "model", type: "select", value: "test-large" }]);
                    }
                    await configureSource([
                        { configId: "mode", type: "select", value: "plan" },
                        { configId: "model", type: "select", value: "test-large" },
                        { configId: "fast_mode", type: "boolean", booleanValue: true },
                    ]);
                    const listId = crypto.randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            kind: "native.session.request",
                            action: "list",
                            requestId: listId,
                            cursor: null,
                        }),
                    );
                    const list = decodeNativeSessionResult(await nextMessage(peer, "native.session.result"));
                    if (list.action !== "list" || list.entries[0] === undefined) {
                        throw new Error("Missing native source");
                    }
                    const requestId = crypto.randomUUID();
                    // Only the harness allocates the independent fork's native target.
                    peer.send(
                        JSON.stringify({
                            ...identity,
                            kind: "native.session.request",
                            action: "fork",
                            requestId,
                            sessionId: list.entries[0].sessionId,
                        }),
                    );
                    const modeAndSpeed = [
                        expect.objectContaining({ id: "mode", currentValue: "plan" }),
                        expect.objectContaining({ id: "fast_mode", booleanValue: true }),
                    ];
                    const selections = [
                        ...modeAndSpeed,
                        expect.objectContaining({ id: "model", currentValue: "test-large" }),
                    ];
                    if (fault === "--fork-mode-unavailable" || fault === "--fork-omits-mode") {
                        const failure = decodeSessionOperationFailedEvent(
                            await nextMessage(peer, "session.operation.failed"),
                        );
                        expect(failure).toMatchObject({ requestId, code: "invalid_session_configuration" });
                    } else {
                        const fork = decodeNativeSessionResult(await nextMessage(peer, "native.session.result"));
                        if (fork.action !== "fork") {
                            throw new Error("Expected native fork");
                        }
                        expect(fork).toMatchObject({
                            action: "fork",
                            requestId,
                            ready: {
                                target: fork.target,
                                configOptions: expect.arrayContaining(
                                    fault === "--fork-omits-model" ? modeAndSpeed : selections,
                                ),
                            },
                        });
                    }
                    peer.send(
                        encodeSessionPrepareCommand({
                            kind: "session.prepare",
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                        }),
                    );
                    expect(decodeSessionReadyEvent(await nextMessage(peer, "session.ready")).configOptions).toEqual(
                        expect.arrayContaining(selections),
                    );
                },
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

async function nextMessage(peer: RealDaemonPeer, expectedKind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === expectedKind) {
            return message;
        }
        if (kind === "session.operation.failed" || kind === "native.session.result") {
            throw new Error(`Unexpected ${kind}: ${message}`);
        }
    }
}
