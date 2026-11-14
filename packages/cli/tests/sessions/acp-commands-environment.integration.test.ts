import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgent, fakeAgentPath, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp commands environment", () => {
    it("Given an ACP Agent has not advertised commands, When Morty prepares a session, Then it does not invent compact", async () => {
        const manager = new SessionManager({
            observer: {},
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            lastTurn: () => undefined,
            settledTurns: () => [],
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Controlled ACP"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
        );

        try {
            const prepared = await manager.prepareSession({
                agent,
                cwd: process.cwd(),
                target: await manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });

            expect(prepared.commands).toEqual([]);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP Agent advertises compact, When its commands update, Then Morty preserves the ACP command", async () => {
        const harness = "unknown-acp";
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            lastTurn: () => undefined,
            settledTurns: () => [],
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = fakeAgent(["--advertise-compact-command"], {}, harness);

        try {
            await manager.runPrompt({
                agent,
                commandId: `${harness}-compact-command`,
                cwd: process.cwd(),
                images: [],
                prompt: "advertise commands",
                resources: [],
                target: await manager.createNativeSession({
                    agent,
                    cwd: process.cwd(),
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });

            expect(
                observer
                    .acpUpdates()
                    .filter((update) => update.sessionUpdate === "available_commands_update")
                    .at(-1)?.availableCommands,
            ).toEqual([
                {
                    description: "Review the current workspace",
                    input: { hint: "optional focus" },
                    name: "review",
                },
                {
                    description: "Compact the current conversation",
                    name: "compact",
                },
            ]);
        } finally {
            await manager.close();
        }
    });

    it("Given a managed Computer has a login-shell-only Agent environment, When it starts an ACP session, Then the Agent receives that environment", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "morty-login-shell-workspace-"));
        const generatedImages = await mkdtemp(join(tmpdir(), "morty-login-shell-images-"));
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            lastTurn: () => undefined,
            settledTurns: () => [],
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const localContext = new RuntimeLocalContext(join(workspace, "state"), {
            FAKE_ACP_IMAGE_DIRECTORY: generatedImages,
            PATH: process.env["PATH"] ?? "",
        });
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                computerId: "login-shell-environment",
                defaultWorkspace: workspace,
                relayUrl: new URL("ws://127.0.0.1:8787/v1/computers/connect"),
            },
            [fakeAgent()],
            localContext,
            async (agent) => agent,
        );
        try {
            await manager.runPrompt({
                agent: config.catalog.find("codex"),
                commandId: "login-shell-command",
                cwd: workspace,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                target: await manager.createNativeSession({
                    agent: config.catalog.find("codex"),
                    cwd: workspace,
                    signal: AbortSignal.timeout(10_000),
                }),
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(join(generatedImages, "generated-image.png"));
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });
});
