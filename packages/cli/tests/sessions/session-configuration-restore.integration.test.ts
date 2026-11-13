import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeSessionConfigUpdatedEvent,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionConfigureCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { prepareNewRealSession, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

class ModelDependentSettingsAgent extends ControlledAcpSpecification {
    readonly agentExecutable = "node";
    readonly harness = "controlled-acp";
    readonly label = "Controlled model-dependent settings";
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor() {
        super("MORTY_TEST_MODEL_DEPENDENT_SETTINGS_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            "--reasoning-effort-for-test-large-only",
            "--recover-default-settings",
        ]);
    }
}

test("Given effort was chosen before the model it depends on, When the conversation reopens in a new Agent process, Then both settings are restored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-config-restore-"));
    try {
        await withControlledDaemon(
            new ModelDependentSettingsAgent(),
            {
                MORTY_TEST_MODEL_DEPENDENT_SETTINGS_PATH: process.execPath,
                MORTY_FAKE_ACP_STATE_DIRECTORY: directory,
            },
            async (peer) => {
                const sessionTarget = await prepareNewRealSession(peer, "controlled-acp");
                await prompt(peer, sessionTarget);
                let revision = await configure(peer, sessionTarget, "model", "test-large", "");
                revision = await configure(peer, sessionTarget, "reasoning_effort", "high", revision);
                // Trying another model and returning makes the model the latest edit.
                revision = await configure(peer, sessionTarget, "model", "test-small", revision);
                await configure(peer, sessionTarget, "model", "test-large", revision);

                // A restarted daemon reopens the conversation in a new Agent process.
                await peer.restart();
                expect(await prepare(peer, sessionTarget)).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ id: "model", currentValue: "test-large" }),
                        expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }),
                    ]),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Given a setting was chosen before the first prompt, When the daemon restarts and the Session reopens, Then the setting is kept", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-config-restore-"));
    try {
        await withControlledDaemon(
            new ModelDependentSettingsAgent(),
            {
                MORTY_TEST_MODEL_DEPENDENT_SETTINGS_PATH: process.execPath,
                MORTY_FAKE_ACP_STATE_DIRECTORY: directory,
            },
            async (peer) => {
                const sessionTarget = await prepareNewRealSession(peer, "controlled-acp");
                await configure(peer, sessionTarget, "model", "test-large", "");

                await peer.restart();
                expect(await prepare(peer, sessionTarget)).toEqual(
                    expect.arrayContaining([expect.objectContaining({ id: "model", currentValue: "test-large" })]),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

async function prompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"]): Promise<void> {
    const commandId = crypto.randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            kind: "session.prompt",
            prompt: "Start the conversation",
            target: sessionTarget,
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
}

async function prepare(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"]) {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionPrepareCommand({ kind: "session.prepare", requestId, target: sessionTarget }));
    for (;;) {
        const message = await nextMessage(peer, "session.ready");
        const ready = decodeSessionReadyEvent(message);
        if (ready.requestId === requestId) {
            return ready.configOptions;
        }
    }
}

/** Changes one setting as the Web does and returns the revision the next change must name. */
async function configure(
    peer: RealDaemonPeer,
    sessionTarget: RealDaemonPeer["target"],
    configId: string,
    value: string,
    expectedRevision: string,
): Promise<string> {
    const revision = expectedRevision.length > 0 ? expectedRevision : await currentRevision(peer, sessionTarget);
    const requestId = crypto.randomUUID();
    peer.send(
        encodeSessionConfigureCommand({
            configId,
            expectedConfigurationRevision: revision,
            kind: "session.configure",
            requestId,
            target: sessionTarget,
            value,
            type: "select",
        }),
    );
    for (;;) {
        const updated = decodeSessionConfigUpdatedEvent(await nextMessage(peer, "session.config.updated"));
        if (updated.requestId === requestId) {
            return updated.configurationRevision;
        }
    }
}

async function currentRevision(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"]): Promise<string> {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionPrepareCommand({ kind: "session.prepare", requestId, target: sessionTarget }));
    for (;;) {
        const ready = decodeSessionReadyEvent(await nextMessage(peer, "session.ready"));
        if (ready.requestId === requestId) {
            return ready.configurationRevision;
        }
    }
}

async function nextMessage(peer: RealDaemonPeer, expectedKind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === expectedKind) {
            return message;
        }
        if (kind === "session.operation.failed") {
            throw new Error(`Unexpected ${kind}: ${message}`);
        }
    }
}
