import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionLiveEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { executableLaunch } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

async function writeTurnPolicyRecorder(
    codex: CodexFixture,
    launcher: string,
    recording: string,
    launches: string,
): Promise<void> {
    const launch = executableLaunch(codex.executable, []);
    await writeFile(
        launcher,
        `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(launches)}, "started\\n");
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...${JSON.stringify(codex.environment)} },
});
createInterface({input: process.stdin}).on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "turn/start") {
        const params = message.params ?? {};
        writeFileSync(${JSON.stringify(recording)}, JSON.stringify({
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer,
            sandboxPolicy: params.sandboxPolicy,
            summary: params.summary,
        }));
    }
    if (!child.stdin.destroyed) child.stdin.write(line + "\\n");
});
createInterface({input: child.stdout}).on("line", line => process.stdout.write(line + "\\n"));
child.stdin.on("error", () => {});
child.once("error", () => process.exit(1));
child.once("exit", code => process.exit(code ?? 1));
`,
        { mode: 0o700 },
    );
}

async function launchCount(path: string): Promise<number> {
    try {
        return (await readFile(path, "utf8")).trim().split("\n").length;
    } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return 0;
        }
        throw cause;
    }
}

test("Given Codex publishes complete model settings and defaults to Full access, When a user discovers settings and runs a tool, Then discovery uses one process and the turn completes without approval", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "SETTINGS_REPLY", {
        patch: "*** Begin Patch\n*** Add File: full-access-check.txt\n+full access\n*** End Patch",
    });
    await using codex = await CodexFixture.create(provider, {
        approvalPolicy: "on-request",
    });
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-settings-"));
    const launcher = join(directory, "codex.mjs");
    const recording = join(directory, "turn-policy.json");
    const launches = join(directory, "launches.log");
    await writeTurnPolicyRecorder(codex, launcher, recording, launches);
    const environment = { ...codex.environment, MORTY_CODEX_PATH: launcher };
    try {
        await withRealDaemon(new CodexAgentSpecification(), environment, async (peer) => {
            const launchesBeforeSettings = await launchCount(launches);
            const requestId = randomUUID();
            peer.send(
                encodeAgentSettingsDiscoverCommand({ kind: "agent.settings.discover", harness: "codex", requestId }),
            );
            let discovered: ReturnType<typeof decodeAgentSettingsDiscoveredEvent>;
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "agent.settings.discovered") {
                    discovered = decodeAgentSettingsDiscoveredEvent(message);
                    break;
                }
            }
            expect(discovered.requestId).toBe(requestId);
            expect((await launchCount(launches)) - launchesBeforeSettings).toBe(1);
            const selectValues = (id: string) => {
                const setting = discovered.settings.find((candidate) => candidate.id === id);
                return setting?.type === "select" ? setting.values : [];
            };
            const model = selectValues("model")[0]?.value;
            const effort = selectValues("reasoning_effort").find((option) => option.value === "high")?.value;
            if (model === undefined || effort === undefined) {
                throw new Error("Codex did not advertise model/effort settings");
            }
            expect(discovered.settings.find((setting) => setting.id === "fast-mode")).toMatchObject({
                type: "boolean",
            });
            expect(selectValues("collaboration_mode")).toContainEqual(expect.objectContaining({ value: "plan" }));
            expect(discovered.settings.find((setting) => setting.id === "mode")).toMatchObject({
                defaultValue: "agent-full-access",
            });
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    attachments: [],
                    prompt: fakeProviderPrompts.successfulTool,
                    disposition: SessionPromptDisposition.Append,
                    sessionConfigurations: [
                        { configId: "model", type: "select", value: model },
                        { configId: "reasoning_effort", type: "select", value: effort },
                        { configId: "fast-mode", type: "boolean", booleanValue: true },
                        { configId: "collaboration_mode", type: "select", value: "plan" },
                    ],
                }),
            );
            let text = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    throw new Error("Codex requested approval while Full access was the default mode");
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
            expect(text).toContain("SETTINGS_REPLY");
            expect(provider.diagnostics()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        model,
                        reasoning: expect.objectContaining({ effort }),
                        serviceTier: "priority",
                    }),
                ]),
            );
        });
        expect(JSON.parse(await readFile(recording, "utf8"))).toEqual({
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
            summary: "auto",
        });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("Given Codex starts with a configured model outside its catalog, When Agent settings are discovered, Then the configured model remains the default", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-custom-model", "CUSTOM_MODEL_REPLY");
    await using codex = await CodexFixture.create(provider, { configuredModel: provider.model });

    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const requestId = randomUUID();
        peer.send(encodeAgentSettingsDiscoverCommand({ kind: "agent.settings.discover", harness: "codex", requestId }));

        let discovered: ReturnType<typeof decodeAgentSettingsDiscoveredEvent>;
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "agent.settings.discovered") {
                discovered = decodeAgentSettingsDiscoveredEvent(message);
                break;
            }
        }

        expect(discovered.requestId).toBe(requestId);
        expect(discovered.settings.find((setting) => setting.id === "model")).toMatchObject({
            defaultValue: "morty-custom-model",
            values: expect.arrayContaining([expect.objectContaining({ value: "morty-custom-model" })]),
        });
    });
});
