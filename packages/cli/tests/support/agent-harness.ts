import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { ControlledAcpConnection } from "./agents/controlled-acp-connection.ts";
import { createControlledAgent } from "./agents/controlled-agent-definition.ts";

const harnessPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));

export interface FakeAgentHarnessDefinition {
    readonly harness: string;
    readonly label: string;
    readonly arguments?: readonly string[];
    readonly isolatedNativeStorage?: boolean;
}

export function fakeAgentHarnessCapabilities(definition: FakeAgentHarnessDefinition) {
    return {
        audioPrompt: false,
        closeSession: true,
        deleteSession: true,
        embeddedContextPrompt: true,
        imagePrompt: true,
        listSessions: true,
        loadSession: true,
        promptQueueing: true,
        renameSession: !(definition.arguments ?? []).includes("--no-rename-session"),
        resumeSession: !(definition.arguments ?? []).includes("--load-only"),
        steering: true,
        unstableForkSession: true,
    };
}

export function fakeAgentHarness(definition: FakeAgentHarnessDefinition, stateDirectory: string): AcpAgentDefinition {
    const nativeStorage =
        definition.isolatedNativeStorage === true ? join(stateDirectory, definition.harness) : stateDirectory;
    mkdirSync(nativeStorage, { recursive: true });
    return createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: definition.harness,
                    adapterPath: process.execPath,
                    arguments: [harnessPath, "--agent-name", definition.label, ...(definition.arguments ?? [])],
                    environment: options.environment,
                },
                options,
            ),
        definition.harness,
        definition.label,
        process.execPath,
        { MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStorage },
        "1.0.0",
        fakeAgentHarnessCapabilities(definition),
    );
}

export const defaultFakeAgentHarness: FakeAgentHarnessDefinition = {
    arguments: ["--load-only"],
    harness: "claude",
    label: "Codex",
};
