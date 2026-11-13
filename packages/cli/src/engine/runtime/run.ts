import { styleText } from "node:util";
import { createComputerPayloadEncryption } from "@morty-build/client";
import { createRuntimeAdapterRegistry } from "../acp/adapter/adapter-registry.ts";
import { buildSessionLayer } from "../session/api/session-layer.ts";
import { LocalExternalContentStore } from "../session/content/external-content-store.ts";
import { AgentProcessPool } from "../session/process/agent-process-pool.ts";
import { runCleanup } from "../util/run-cleanup.ts";
import { systemTimer, type Timer } from "../util/timer.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { resolveCatalogAgent } from "./catalog/resolve-catalog-agent.ts";
import type { RuntimeConfig } from "./config.ts";
import { ComputerEncryptionStore } from "./connection/computer-encryption-store.ts";
import { RuntimeDiagnosticLog } from "./observability/diagnostic-log.ts";
import { ComputerRelayRevokedError } from "./relay/computer-revocation.ts";
import { RelayConnectionDiagnostics } from "./relay/diagnostics.ts";
import { runRelayConnection } from "./relay/run-relay-connection.ts";
import { RuntimeSessionEventPublisher } from "./relay/session-event-publisher.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;

function waitForRelayRetry(signal: AbortSignal, timer: Timer): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const retry = timer.schedule(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

        function finish(): void {
            retry.cancel();
            signal.removeEventListener("abort", finish);
            resolve();
        }

        signal.addEventListener("abort", finish, { once: true });
    });
}

async function publishAgentCatalogUntilAvailable(
    config: RuntimeConfig,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
    timer: Timer,
): Promise<void> {
    try {
        await publishAgentCatalog(config, signal);
        return;
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        diagnostics.catalogFailed(error);
    }

    while (!signal.aborted) {
        await waitForRelayRetry(signal, timer);
        try {
            await publishAgentCatalog(config, signal);
            return;
        } catch {
            if (signal.aborted) {
                return;
            }
        }
    }
}

export interface RunRuntimeOptions {
    /** The pool the Runtime's Agent processes run in; the daemon keeps it to release idle processes on request. */
    readonly processes?: AgentProcessPool;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
}

export async function runRuntime(
    config: RuntimeConfig,
    parentSignal: AbortSignal,
    timer: Timer = systemTimer,
    options: RunRuntimeOptions = {},
): Promise<void> {
    const shutdown = new AbortController();
    const signal = AbortSignal.any([parentSignal, shutdown.signal]);
    const stateDirectory = config.localContext.stateDirectory;
    const diagnostics = new RelayConnectionDiagnostics(
        config.computerId,
        config.relayUrl,
        new RuntimeDiagnosticLog(stateDirectory),
    );
    const encryptionSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const encryptionStore = await ComputerEncryptionStore.open(stateDirectory, config.computerId, encryptionSignal);
    const access = await encryptionStore.access(encryptionSignal);
    const payloadEncryption = await createComputerPayloadEncryption(
        access,
        (claim, claimSignal) => encryptionStore.authorizeAndClaim(access.computerE2EAccessSecret, claim, claimSignal),
        encryptionSignal,
    );
    try {
        const publisher = new RuntimeSessionEventPublisher(timer, payloadEncryption);
        // Dispose media only after session and adapter operations have drained.
        await using externalContent = new LocalExternalContentStore(stateDirectory);
        const processes = options.processes ?? new AgentProcessPool(undefined, timer);
        const { adapters, externalizeSessionUpdate } = createRuntimeAdapterRegistry(
            config.adapters,
            processes,
            (target, content, contentSignal) => externalContent.put({ ...content, target, signal: contentSignal }),
            externalContent.linkedResources,
        );
        const resolveAgent = async (harness: string, resolveSignal: AbortSignal) => {
            const agent = await resolveCatalogAgent(config, harness, resolveSignal);
            return {
                agent,
                adapter: adapters.resolve(agent),
                externalizeSessionUpdate,
            };
        };
        const layer = buildSessionLayer({
            processes,
            computerId: config.computerId,
            defaultWorkspace: config.defaultWorkspace,
            resolveAgent,
            sink: publisher,
            stateDirectory: config.localContext.stateDirectory,
            timer,
        });
        const {
            activeSessions,
            directories,
            eventProjection,
            manager: agentRuntime,
            nativeSessions,
            operations,
            sessionStore,
            sessionCreations,
        } = layer;
        let connectionEpoch = 0;
        let connectionAnnounced = false;
        let catalogPublished = false;
        let readinessAnnounced = false;
        const announceReadiness = (): void => {
            if (!connectionAnnounced || !catalogPublished) {
                return;
            }
            options.onConnectionStatus?.("online");
            if (readinessAnnounced) {
                return;
            }
            readinessAnnounced = true;
            process.stdout.write("Morty Computer is ready for Agent requests.\n");
        };
        const announceConnection = (): void => {
            if (connectionAnnounced) {
                return;
            }
            connectionAnnounced = true;
            process.stdout.write("Morty Computer connected to the relay.\n\n");
            process.stdout.write(
                `${styleText(["bold", "yellow"], "Reconnect this local connection later:\n  morty start")}\n\n`,
            );
            announceReadiness();
        };
        const catalogPublication = publishAgentCatalogUntilAvailable(config, diagnostics, signal, timer);
        void catalogPublication.then(() => {
            if (signal.aborted) {
                return;
            }
            catalogPublished = true;
            announceReadiness();
        });

        try {
            while (!signal.aborted) {
                connectionEpoch += 1;
                try {
                    await runRelayConnection({
                        config,
                        resolveAgent,
                        directories,
                        sessions: agentRuntime,
                        sessionCreations,
                        nativeSessions,
                        operations,
                        publisher,
                        payloadEncryption,
                        eventProjection,
                        externalContent,
                        sessionTurns: activeSessions,
                        connectionEpoch,
                        diagnostics,
                        onConnected: () => {
                            if (catalogPublished) {
                                options.onConnectionStatus?.("online");
                            }
                            announceConnection();
                        },
                        signal,
                        timer,
                    });
                } catch (error) {
                    if (signal.aborted) {
                        return;
                    }
                    if (error instanceof ComputerRelayRevokedError) {
                        throw error;
                    }
                    diagnostics.connectionFailed(connectionEpoch, error, "connection");
                }

                options.onConnectionStatus?.("reconnecting");
                await waitForRelayRetry(signal, timer);
            }
        } finally {
            shutdown.abort();
            operations.beginShutdown();
            await activeSessions.close();
            await runCleanup(
                () => catalogPublication,
                () => nativeSessions.close(),
                () => sessionCreations.settle(),
                () => agentRuntime.close(),
                () => adapters.close(),
                () => sessionStore.close(),
                () => publisher.close(),
                () => operations.close(),
            );
        }
    } finally {
        payloadEncryption.close();
    }
}
