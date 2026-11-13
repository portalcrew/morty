import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    createFakeDaemon,
    type FakeAgentHarnessOptions,
    type HarnessReplyPlan,
} from "@morty-build/runtime-test-support/fake-daemon";
import * as v from "valibot";
import {
    createRuntimeConfig,
    RuntimeAgentDependencies,
    RuntimeLocalContext,
} from "../../../packages/cli/src/engine/runtime/config.ts";
import type { ComputerCredentials } from "../../../packages/cli/src/engine/runtime/connection/computer-credentials.ts";
import { ComputerEncryptionStore } from "../../../packages/cli/src/engine/runtime/connection/computer-encryption-store.ts";
import { runRuntime } from "../../../packages/cli/src/engine/runtime/run.ts";
import { acpAdapters } from "../../../packages/cli/tests/support/acp-adapters.ts";
import { memoryComputerCredentials } from "../../../packages/cli/tests/support/computer-credentials.ts";
import { createOwnerApi } from "../owner-api.ts";
import { createInteractionAgent } from "./interaction-agent.ts";
import { createSettingsAgent, createUnavailableAgent } from "./settings-agent.ts";
import { createToolLifecycleAgent } from "./tool-lifecycle-agent.ts";

type TestServerApp = { readonly request: (request: Request) => Response | Promise<Response> };

const computerPairingSchema = v.object({
    pairingCode: v.string(),
    computerId: v.string(),
});

const computerClaimSchema = v.object({
    computerId: v.string(),
    computerCredential: v.string(),
});

export interface ControlledComputerConnection {
    readonly computerId: string;
    readonly origin: string;
    /** The Computer's relay credential; it rotates on every connection and outlives restarts, as a saved one does. */
    readonly credentials: ComputerCredentials;
}

/** An Agent the controlled Computer exposes. */
export interface ControlledAgent {
    readonly harness: string;
    readonly label: string;
    /** Controls replies through the real daemon's Agent dependency. */
    readonly reply?: FakeAgentHarnessOptions["reply"];
    /** Holds or rejects the controlled Agent's next Session creation through its real ACP boundary. */
    readonly beforeSessionCreated?: (() => Promise<void>) | undefined;
    readonly beforeSessionsListed?: ((signal: AbortSignal) => Promise<void>) | undefined;
    /** Test control that holds a selected Agent configuration request before it is applied. */
    readonly beforeConfigurationApplied?: ((configId: string, value: string | boolean) => Promise<void>) | undefined;
    /** Holds the controlled Agent's cancellation while its current reply remains active. */
    readonly beforeCancellationApplied?: (() => Promise<void>) | undefined;
    readonly onBackgroundPermissionReady?: ((request: () => Promise<void>) => void) | undefined;
}

export interface ControlledAgentBehavior extends FakeAgentHarnessOptions {
    readonly beforeSessionCreated?: (() => Promise<void>) | undefined;
    readonly beforeSessionsListed?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly beforeConfigurationApplied?: ((configId: string, value: string | boolean) => Promise<void>) | undefined;
    readonly beforeCancellationApplied?: (() => Promise<void>) | undefined;
    readonly onBackgroundPermissionReady?: ((request: () => Promise<void>) => void) | undefined;
    readonly files?: ReadonlyMap<string, { readonly content: string | Uint8Array; readonly mediaType: string }>;
}

type RuntimeConnectionOptions = Parameters<typeof createRuntimeConfig>[0];

/** Creates the daemon configuration once, so Agent state survives restarts of its engine. */
function controlledRuntime(
    agents: ReturnType<typeof createMortyFakeDaemon>["agents"],
    connection: RuntimeConnectionOptions,
    directory: string,
): {
    readonly start: (
        signal: AbortSignal,
        onConnectionStatus: (status: "online" | "reconnecting") => void,
    ) => Promise<void>;
} {
    const config = createRuntimeConfig(
        connection,
        new RuntimeAgentDependencies(agents, acpAdapters),
        new RuntimeLocalContext(directory, process.env),
        async (agent) => agent,
    );
    return {
        start: (signal, onConnectionStatus) => runRuntime(config, signal, undefined, { onConnectionStatus }),
    };
}

function workspaceReply(behavior: ControlledAgentBehavior, workspace: string): FakeAgentHarnessOptions["reply"] {
    const workspaceUrl = pathToFileURL(`${workspace}/`).href;
    return (prompt, turnNumber, mode): HarnessReplyPlan => {
        const plan = behavior.reply(prompt, turnNumber, mode);
        return {
            outcome: plan.outcome,
            output: plan.output.map((output) =>
                output.kind === "text"
                    ? { ...output, text: output.text.replaceAll("file:///workspace/", workspaceUrl) }
                    : output,
            ),
        };
    };
}

async function writeWorkspaceFiles(
    files: ControlledAgentBehavior["files"],
    workspace: string,
    signal: AbortSignal,
): Promise<void> {
    for (const [requestedPath, file] of files ?? []) {
        signal.throwIfAborted();
        if (!requestedPath.startsWith("/workspace/")) {
            throw new Error("Controlled Agent file paths must be inside /workspace");
        }
        const target = resolve(workspace, requestedPath.slice("/workspace/".length));
        const child = relative(workspace, target);
        if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
            throw new Error("Controlled Agent file path escaped /workspace");
        }
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, file.content, { signal });
    }
}

export function createMortyFakeDaemon(behavior: ControlledAgentBehavior, workspace?: string) {
    const harness = createFakeDaemon(
        workspace === undefined ? behavior : { ...behavior, reply: workspaceReply(behavior, workspace) },
    );
    if (behavior.harness === "diagnostics-test") {
        return { ...harness, agents: [createSettingsAgent("diagnostics")] };
    }
    if (behavior.harness === "tool-lifecycle-test") {
        return { ...harness, agents: [createToolLifecycleAgent(behavior.beforeCancellationApplied)] };
    }
    if (behavior.harness === "interaction-test") {
        return { ...harness, agents: [createInteractionAgent(behavior.onBackgroundPermissionReady)] };
    }
    if (behavior.harness === "configuration-test") {
        return {
            ...harness,
            agents: [createSettingsAgent("full", behavior.beforeConfigurationApplied, behavior.beforeSessionCreated)],
        };
    }
    if (behavior.harness === "dependent-settings-test") {
        return { ...harness, agents: [createSettingsAgent("dependent")] };
    }
    if (behavior.harness === "settings-test") {
        return {
            ...harness,
            agents: [
                createSettingsAgent("model", undefined, behavior.beforeSessionCreated, behavior.beforeSessionsListed),
            ],
        };
    }
    if (behavior.harness === "signed-out-test") {
        return { ...harness, agents: [createUnavailableAgent("signed-out-test", "Signed-out Agent", "signed-out")] };
    }
    if (behavior.harness === "broken-test") {
        return { ...harness, agents: [createUnavailableAgent("broken-test", "Broken Agent", "broken")] };
    }
    return harness;
}

export async function connectControlledAgentRuntime(options: {
    readonly behavior: ControlledAgentBehavior;
    readonly connection: ControlledComputerConnection;
    readonly signal: AbortSignal;
}) {
    options.signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "morty-controlled-agent-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeWorkspaceFiles(options.behavior.files, workspace, options.signal);
    const relayUrl = new URL("/morty/api/v1/computers/connect", options.connection.origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    let connection = options.connection;
    let behavior = options.behavior;
    // The Agents can change across restarts, as when the user installs another Agent on the computer.
    const configure = (behavior: ControlledAgentBehavior) => {
        const harness = createMortyFakeDaemon(behavior, workspace);
        const runtime = controlledRuntime(
            harness.agents,
            {
                computerId: connection.computerId,
                defaultWorkspace: workspace,
                relayUrl,
                credentials: connection.credentials,
            },
            directory,
        );
        return { harness, runtime };
    };
    let { harness, runtime } = configure(behavior);
    const unexpectedFailure = Promise.withResolvers<never>();
    void unexpectedFailure.promise.catch(() => undefined);
    const start = async () => {
        const cancellation = new AbortController();
        const signal = AbortSignal.any([options.signal, cancellation.signal]);
        const ready = Promise.withResolvers<void>();
        const daemon = runtime.start(signal, (status) => {
            if (status === "online") {
                ready.resolve();
            }
        });
        const failure = daemon.then<never>(() => {
            throw new Error("The production daemon stopped unexpectedly");
        });
        void failure.catch((cause: unknown) => {
            if (!signal.aborted) {
                unexpectedFailure.reject(cause);
            }
        });
        const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const abortReadiness = (): void => ready.reject(readinessSignal.reason);
        readinessSignal.addEventListener("abort", abortReadiness, { once: true });
        const stop = async (): Promise<void> => {
            cancellation.abort(new Error("Controlled Agent Runtime stopped"));
            await daemon.catch(() => undefined);
        };
        try {
            await Promise.race([ready.promise, failure]);
            return { stop };
        } catch (cause) {
            await stop();
            throw cause;
        } finally {
            readinessSignal.removeEventListener("abort", abortReadiness);
        }
    };
    const initial = await start().catch(async (cause: unknown) => {
        await rm(directory, { force: true, recursive: true });
        throw cause;
    });
    // The Computer's encryption access is fixed for its life. Read it once, before any client traffic can hold the
    // store: a later read would race the daemon's replay claims for the store's non-blocking lock.
    const encryptionAccess = await ComputerEncryptionStore.open(
        directory,
        options.connection.computerId,
        options.signal,
    ).then(async (store) => await store.access(options.signal));
    let state:
        | { readonly kind: "running"; readonly runtime: typeof initial }
        | { readonly kind: "disconnected" }
        | { readonly kind: "disposed" } = { kind: "running", runtime: initial };
    const disconnect = async (): Promise<void> => {
        if (state.kind !== "running") {
            return;
        }
        const runtime = state.runtime;
        state = { kind: "disconnected" };
        await runtime.stop();
    };
    return {
        continueReply: (...reply: Parameters<typeof harness.continueReply>) => harness.continueReply(...reply),
        encryptionAccess: async (signal: AbortSignal) => {
            signal.throwIfAborted();
            return encryptionAccess;
        },
        writeFiles: async (files: NonNullable<ControlledAgentBehavior["files"]>): Promise<void> =>
            await writeWorkspaceFiles(files, workspace, options.signal),
        disconnect,
        reconnect: async (): Promise<void> => {
            if (state.kind === "disposed") {
                throw new Error("Cannot reconnect a disposed controlled Computer");
            }
            if (state.kind === "disconnected") {
                state = { kind: "running", runtime: await start() };
            }
        },
        /** Re-pairs this same Computer without replacing its local identity or Agent-owned history. */
        reconnectWithConnection: async (next: ControlledComputerConnection): Promise<void> => {
            if (
                state.kind === "disposed" ||
                next.computerId !== connection.computerId ||
                next.origin !== connection.origin
            ) {
                throw new Error("Cannot replace this controlled Computer connection");
            }
            await disconnect();
            connection = next;
            ({ harness, runtime } = configure(behavior));
            state = { kind: "running", runtime: await start() };
        },
        /** Restarts the Computer offering other Agents, which it publishes to the Relay when it reconnects. */
        restartWithAgents: async (
            agents: Pick<ControlledAgentBehavior, "additionalAgents" | "harness" | "agentName">,
        ): Promise<void> => {
            if (state.kind === "disposed") {
                throw new Error("Cannot restart a disposed controlled Computer");
            }
            await disconnect();
            behavior = { ...behavior, ...agents };
            ({ harness, runtime } = configure(behavior));
            state = { kind: "running", runtime: await start() };
        },
        failure: unexpectedFailure.promise,
        [Symbol.asyncDispose]: async (): Promise<void> => {
            if (state.kind === "disposed") {
                return;
            }
            await disconnect();
            state = { kind: "disposed" };
            await rm(directory, { force: true, recursive: true });
        },
    };
}

export async function createControlledAgentRuntime(options: {
    readonly behavior: ControlledAgentBehavior;
    readonly credential: string;
    readonly origin: string;
    readonly computerId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const pairing = v.parse(
        computerPairingSchema,
        await (
            await options.server.request(
                new Request(`${options.origin}/morty/api/v1/computers/${options.computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                    headers: {
                        authorization: `Bearer ${options.credential}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                    signal: options.signal,
                }),
            )
        ).json(),
    );
    const harness = createMortyFakeDaemon(options.behavior);
    const claim = v.parse(
        computerClaimSchema,
        await (
            await options.server.request(
                new Request(`${options.origin}/morty/api/v1/computers/${pairing.computerId}/pairing/redeem`, {
                    body: JSON.stringify({
                        agents: harness.catalog,
                        computerName: "Controlled Agent Runtime",
                        pairingCode: pairing.pairingCode,
                        workspaceName: "Controlled workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: options.signal,
                }),
            )
        ).json(),
    );
    const connected = await connectControlledAgentRuntime({
        behavior: options.behavior,
        connection: {
            computerId: claim.computerId,
            origin: options.origin,
            credentials: memoryComputerCredentials(claim.computerCredential),
        },
        signal: options.signal,
    });
    const owner = createOwnerApi({
        credential: options.credential,
        origin: options.origin,
        computerId: pairing.computerId,
        encryptionAccess: await connected.encryptionAccess(options.signal),
        request: async (request) => await options.server.request(request),
    });
    return {
        ...connected,
        api: owner.api,
        createSession: owner.createSession,
        sessionClient: owner.sessionClient,
        [Symbol.asyncDispose]: async () => {
            owner.close();
            await connected[Symbol.asyncDispose]();
        },
        computerId: claim.computerId,
    };
}
