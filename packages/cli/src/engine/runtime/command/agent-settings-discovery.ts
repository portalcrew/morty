import type { PayloadEncryptionConnection } from "@morty-build/client";
import {
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentSettingsDiscoverCommand,
    agentSettingsDiscoveredEventCodec,
    agentSettingsDiscoveryFailedEventCodec,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { OperationError, operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { ResolveAgent } from "../../session/api/session-api.ts";
import { SessionError } from "../../session/api/session-error.ts";
import type { SessionManager } from "../../session/manager/session-manager.ts";
import { agentSettingsFailureDetails, discoverAgentSettings } from "../../session/settings/discover-agent-settings.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import { send } from "./transport.ts";

interface SettingsDiscoveryDependencies {
    readonly resolveAgent: ResolveAgent;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly payloadEncryption: PayloadEncryptionConnection;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export function createAgentSettingsDiscoveryHandler(dependencies: SettingsDiscoveryDependencies) {
    const { directories, sessions, diagnostics, socket, signal, timer, payloadEncryption } = dependencies;
    const replies = new Set<Promise<void>>();
    const fail = (requestId: string, code: string, message: string): void => {
        const reply = (async () => {
            const encoded = await agentSettingsDiscoveryFailedEventCodec.encode(
                { code, kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND, message, requestId },
                payloadEncryption,
                signal,
            );
            if (socket.readyState === WebSocket.OPEN) {
                send(socket, encoded);
            }
        })();
        replies.add(reply);
        void reply
            .catch((error: unknown) => {
                if (!signal.aborted) {
                    console.error("Could not send Agent settings failure", error);
                }
            })
            .finally(() => replies.delete(reply));
    };
    const agentSettingsDiscoveries = new Map<
        string,
        {
            readonly harness: string;
            readonly directory: string;
            readonly model: string | undefined;
            readonly requestIds: Set<string>;
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const handle = (command: AgentSettingsDiscoverCommand): void => {
        // Each directory has its own settings, so one discovery runs per Agent and directory.
        const directory = command.directory ?? ".";
        const existing = [...agentSettingsDiscoveries.values()].find(
            (request) =>
                request.harness === command.harness &&
                request.directory === directory &&
                !request.controller.signal.aborted,
        );
        if ([...agentSettingsDiscoveries.values()].some((request) => request.requestIds.has(command.requestId))) {
            if (socket.readyState === WebSocket.OPEN) {
                fail(
                    command.requestId,
                    "agent_settings_discovery_busy",
                    "This settings discovery request is already running",
                );
            }
            return;
        }
        if (existing !== undefined && existing.model === command.model && existing.requestIds.size < 16) {
            existing.requestIds.add(command.requestId);
            return;
        }
        if (existing !== undefined) {
            if (socket.readyState === WebSocket.OPEN) {
                fail(
                    command.requestId,
                    "agent_settings_discovery_busy",
                    "Another settings discovery is already running for this Agent",
                );
            }
            return;
        }
        if (agentSettingsDiscoveries.size >= 4) {
            if (socket.readyState === WebSocket.OPEN) {
                fail(
                    command.requestId,
                    "agent_settings_discovery_busy",
                    "Too many Agent settings discoveries are running",
                );
            }
            return;
        }
        const controller = new AbortController();
        const requestIds = new Set([command.requestId]);
        const operationSignal = AbortSignal.any([signal, controller.signal]);
        const timeout = timer.schedule(
            () =>
                controller.abort(
                    new SessionError("agent_settings_discovery_timeout", "Agent settings discovery timed out"),
                ),
            90_000,
        );
        const completion = (async (): Promise<void> => {
            try {
                const result = await discoverAgentSettings(
                    command,
                    dependencies.resolveAgent,
                    directories,
                    sessions,
                    operationSignal,
                );
                for (const diagnostic of result.unsupportedModels) {
                    const details = agentSettingsFailureDetails(command.harness, diagnostic);
                    diagnostics.daemonDiagnostic("agent_settings_model_unsupported", command.requestId, details);
                    process.stderr.write(
                        `Morty daemon diagnostic ${JSON.stringify({ event: "agent_settings_model_unsupported", requestId: command.requestId, ...details })}\n`,
                    );
                }
                for (const requestId of requestIds) {
                    if (socket.readyState === WebSocket.OPEN) {
                        const encoded = await agentSettingsDiscoveredEventCodec.encode(
                            { ...result.event, requestId },
                            payloadEncryption,
                            operationSignal,
                        );
                        if (socket.readyState === WebSocket.OPEN) {
                            send(socket, encoded);
                        }
                    }
                }
            } catch (error) {
                const failure: unknown = operationSignal.aborted
                    ? (controller.signal.reason ??
                      new SessionError("agent_settings_discovery_cancelled", "Agent settings discovery cancelled"))
                    : error;
                const details = agentSettingsFailureDetails(command.harness, failure);
                diagnostics.daemonDiagnostic("agent_settings_discovery_failed", command.requestId, details, failure);
                if (failure instanceof OperationError && failure.code === "invalid_session_configuration") {
                    process.stderr.write(
                        `Morty daemon diagnostic ${JSON.stringify({ event: "agent_settings_discovery_failed", requestId: command.requestId, ...details })}\n`,
                    );
                }
                if (socket.readyState === WebSocket.OPEN) {
                    for (const requestId of requestIds) {
                        fail(requestId, operationErrorCode(failure), operationErrorMessage(failure));
                    }
                }
            } finally {
                timeout.cancel();
                agentSettingsDiscoveries.delete(command.requestId);
            }
        })();
        agentSettingsDiscoveries.set(command.requestId, {
            harness: command.harness,
            directory,
            model: command.model,
            requestIds,
            completion,
            controller,
        });
        return;
    };
    const settle = async (): Promise<void> => {
        await Promise.all([...agentSettingsDiscoveries.values()].map((request) => request.completion));
        await Promise.allSettled([...replies]);
    };
    return { handle, settle };
}
