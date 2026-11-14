import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpSessionUpdate, NativeSessionCommand, SessionLiveEvent } from "@morty-build/client/protocol";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import { createRuntimeConfig, RuntimeAgentDependencies, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import type { SessionObserver } from "../../src/engine/session/api/session-api.ts";
import { NativeSessionService } from "../../src/engine/session/native/native-session-browser.ts";
import { SessionCreations } from "../../src/engine/session/record/session-creations.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { WorkspaceDirectoryService } from "../../src/engine/session/workspace/workspace-directory.ts";
import { SessionCreationTable } from "../../src/engine/storage/session/session-creation-table.ts";
import { openAcpSessionDatabase } from "../../src/engine/storage/sqlite/local-databases.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

const acpUrl = new URL("./fixtures/acp-peer.ts", import.meta.url).toString();

// Real providers cannot deterministically supply destructive test sessions or stalled
// loads. These ACP subprocesses maintain their own disposable session files.
class NativeSessionObserver implements SessionObserver {
    readonly updates: AcpSessionUpdate[] = [];
    readonly #waiters: { readonly matches: (update: AcpSessionUpdate) => boolean; readonly resolve: () => void }[] = [];
    readonly onSessionEvent = (event: SessionLiveEvent): void => {
        if (event.type === "acp") {
            this.updates.push(event.payload);
            for (const waiter of this.#waiters.splice(0).filter((candidate) => {
                if (candidate.matches(event.payload)) {
                    return true;
                }
                this.#waiters.push(candidate);
                return false;
            })) {
                waiter.resolve();
            }
        }
    };
    /** Settles once an Agent update matching `matches` arrives, or at once if one already has. */
    readonly nextUpdate = (matches: (update: AcpSessionUpdate) => boolean): Promise<void> => {
        if (this.updates.some(matches)) {
            return Promise.resolve();
        }
        const arrived = Promise.withResolvers<void>();
        this.#waiters.push({ matches, resolve: arrived.resolve });
        return arrived.promise;
    };
}

export async function fixture(
    label: "Claude Code" | "Codex" | "Pi",
    profile:
        | "load-only"
        | "replay-history-once"
        | "supported"
        | "unsupported"
        | "invalid-fork"
        | "exclusive-writer"
        | "persist-after-first-prompt" = "supported",
    adapters: AdapterResolver = acpAdapters,
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "morty-native-boundary-")));
    const workspace = join(temporary, "workspace");
    const native = join(temporary, "native");
    await mkdir(workspace);
    await mkdir(native);
    const previous = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
    process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"] = native;
    // Controlled ACP peers are used only for protocol-specific scenarios.
    const executable = join(temporary, "agent.mjs");
    await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(acpUrl)});\n`, { mode: 0o700 });
    const harness = label === "Claude Code" ? "claude" : label === "Codex" ? "codex" : "pi";
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: harness,
                    adapterPath: executable,
                    arguments: [
                        "--agent-name",
                        label,
                        ...(profile === "load-only" ? ["--load-only"] : []),
                        ...(profile === "replay-history-once" ? ["--load-only", "--replay-history-once"] : []),
                        ...(profile === "unsupported"
                            ? ["--no-native-sessions"]
                            : profile === "invalid-fork"
                              ? ["--reuse-session-on-fork"]
                              : profile === "exclusive-writer"
                                ? ["--exclusive-writer"]
                                : profile === "persist-after-first-prompt"
                                  ? ["--persist-after-first-prompt"]
                                  : []),
                    ],
                    environment: options.environment,
                },
                options,
            ),
        harness,
        label,
        executable,
    );
    const store = new MemorySessionStore();
    const observer = new NativeSessionObserver();
    let sessions = new SessionManager({
        observer,
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
    let service = new NativeSessionService(
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
    const seed = async (title: string, cwd = workspace): Promise<string> => {
        const external = new SessionManager({
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
        try {
            const target = await external.createNativeSession({
                agent,
                cwd,
                signal: AbortSignal.timeout(10_000),
            });
            await external.runPrompt({
                agent,
                cwd,
                signal: new AbortController().signal,
                target,
                commandId: crypto.randomUUID(),
                prompt: title,
                images: [],
                resources: [],
            });
            return target.sessionId;
        } finally {
            await external.close();
        }
    };
    const list = async (cursor: string | null = null) => {
        const result = await service.execute({ ...identity, action: "list", cursor }, new AbortController().signal);
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
        if (previous === undefined) {
            delete process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
        } else {
            process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"] = previous;
        }
        await rm(temporary, { recursive: true, force: true });
    };
    return {
        agent,
        config,
        observer,
        directories,
        identity,
        list,
        native,
        seed,
        get service() {
            return service;
        },
        get sessions() {
            return sessions;
        },
        restart: async () => {
            await service.close();
            await sessions.close();
            sessions = new SessionManager({
                observer,
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
            service = new NativeSessionService(
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
        },
        temporary,
        workspace,
        close,
    };
}
