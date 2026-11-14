import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionCommand, NativeSessionTarget } from "@morty-build/client/protocol";
import { harnessAdapters } from "../../../src/engine/acp/adapter/registry.ts";
import { AcpContentExternalizer } from "../../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterResolver } from "../../../src/engine/acp/native-history/preview-contract.ts";
import {
    createRuntimeConfig,
    RuntimeAgentDependencies,
    RuntimeLocalContext,
} from "../../../src/engine/runtime/config.ts";
import { NativeSessionService } from "../../../src/engine/session/native/native-session-browser.ts";
import { SessionCreations } from "../../../src/engine/session/record/session-creations.ts";
import { MemorySessionStore } from "../../../src/engine/session/record/session-store.ts";
import { WorkspaceDirectoryService } from "../../../src/engine/session/workspace/workspace-directory.ts";
import { SessionCreationTable } from "../../../src/engine/storage/session/session-creation-table.ts";
import { openAcpSessionDatabase } from "../../../src/engine/storage/sqlite/local-databases.ts";
import { systemTimer } from "../../../src/engine/util/timer.ts";
import { testAgentDefinition } from "../agent-definition.ts";
import { memoryComputerCredentials } from "../computer-credentials.ts";
import { FakeOpenAiProvider } from "../llm/openai.ts";
import { SessionRuntimeFixture as SessionManager } from "../session-runtime.ts";
import { UnretainedExternalContentStore } from "../unretained-external-content-store.ts";
import { CodexFixture } from "./codex.ts";

export async function codexFixture(
    answer = "REAL_CODEX_REPLY",
    providerOptions: Parameters<typeof FakeOpenAiProvider.start>[2] = {},
    adapters: AdapterResolver = harnessAdapters,
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "morty-native-codex-")));
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    const provider = await FakeOpenAiProvider.start("morty-test-model", answer, providerOptions);
    const codex = await CodexFixture.create(provider);
    const agent = testAgentDefinition("codex", "Codex", codex.executable, codex.environment);
    const store = new MemorySessionStore();
    const sessions = new SessionManager({
        observer: {},
        store,
        adapters,
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
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            defaultWorkspace: workspace,
            computerId: "test-channel",
            relayUrl: new URL("ws://localhost/"),
        },
        new RuntimeAgentDependencies([agent]),
        new RuntimeLocalContext(workspace, process.env),
        async (agent) => agent,
    );
    const directories = new WorkspaceDirectoryService(workspace);
    const database = openAcpSessionDatabase(join(temporary, "operations.sqlite"));
    const creations = new SessionCreations(new SessionCreationTable(database));
    const service = new NativeSessionService(
        (harness) => sessions.resolveAgent(config.catalog.find(harness)),
        directories,
        sessions.sessions,
        creations,
        () => ({
            turn: null,
            queued: [],
            executionPosition: { sessionGenerationId: "fixture-generation", throughPosition: "0" },
            interactionState: null,
        }),
    );
    const identity = {
        harness: agent.harness,
        directory: ".",
        kind: "native.session.request",
        requestId: "native-operation",
    } satisfies Omit<Extract<NativeSessionCommand, { readonly action: "find" }>, "action" | "sessionId">;
    const prompt = async (target: NativeSessionTarget, text: string): Promise<void> => {
        await sessions.runPrompt({
            agent,
            cwd: workspace,
            target,
            commandId: crypto.randomUUID(),
            prompt: text,
            images: [],
            resources: [],
            signal: AbortSignal.timeout(30_000),
        });
    };
    const seed = async (title: string): Promise<string> => {
        const sessionTarget = await sessions.createNativeSession({
            agent,
            cwd: workspace,
            signal: AbortSignal.timeout(30_000),
        });
        await prompt(sessionTarget, title);
        return sessionTarget.sessionId;
    };
    const list = async (cursor: string | null = null) => {
        const result = await service.execute({ ...identity, action: "list", cursor }, AbortSignal.timeout(30_000));
        if (result.action !== "list") {
            throw new Error("Expected a native session list");
        }
        return result;
    };
    const close = async (): Promise<void> => {
        await service.close();
        await sessions.close();
        await creations.settle();
        database.close();
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
        await rm(temporary, { recursive: true, force: true });
    };
    return { agent, identity, list, seed, prompt, sessions, service, workspace, close };
}
