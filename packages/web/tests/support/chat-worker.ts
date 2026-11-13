import { resolve } from "node:path";
import { createClientPayloadEncryption, type PayloadEncryptionConnection } from "@morty-build/client";
import {
    decodeKnownSessionLiveEventBatch,
    decodeMessageKind,
    nativeSessionResultCodec,
    sessionEventEnvelopeCodec,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createResponseLossProxy } from "../../../relay-test-support/src/response-loss-proxy.ts";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
import { rememberComputerEncryption } from "../../src/services/identity/remembered-computers.ts";
import { TestApiTransport } from "./test-api-transport.ts";

/**
 * The budget of a scenario that starts its own Chat and Relay Workers. Starting them costs seconds on a busy
 * runner, on top of the waits the shared test budget already covers, so these scenarios get room for both.
 */
export const dedicatedEnvironmentTimeout = 60_000;

export async function createChatWorkerEnvironment(
    loseTurnResponses = false,
    delayExecutionReads = false,
    loseSharingResponses = false,
) {
    const observers = new Set<PayloadEncryptionConnection>();
    const cloud = await createIdentityFixture({
        listenOnLoopback: true,
        ...(loseTurnResponses ? { loseTurnResponses: true as const } : {}),
        ...(delayExecutionReads ? { delayExecutionReads: true as const } : {}),
        relayAllowedOrigins: new Set(["*"]),
        workerEntryPoint: resolve(process.cwd(), "../worker/tests/support/credential-storage-worker.ts"),
    });
    const sharingNetwork = loseSharingResponses ? await createResponseLossProxy(cloud.origin) : null;
    const origin = sharingNetwork?.origin ?? cloud.origin;
    if (sharingNetwork !== null) {
        await cloud.changeAppOrigin(origin);
    }
    const createApplication = async () => {
        const identityResponse = await cloud.dispatchFetch(`${origin}/morty/api/v1/computers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            }),
        });
        if (identityResponse.status !== 201) {
            throw new Error(`Could not create an anonymous Morty identity: ${identityResponse.status}`);
        }
        const issued = v.parse(
            v.object({
                computerToken: v.string(),
                computerId: v.string(),
            }),
            await identityResponse.json(),
        );
        const identity = { computerId: issued.computerId, token: issued.computerToken };
        const request = async (path: string, body?: object, method = body === undefined ? "GET" : "POST") =>
            await cloud.dispatchFetch(`${origin}/morty/api/${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const computerId = identity.computerId;
        const transport = new TestApiTransport(origin);
        transport.open();
        const connect = async (agents: readonly ControlledAgent[], sessionIds?: ReadonlySet<string>) => {
            const runtime = await cloud.connectAgent(identity.computerId, identity.token, agents, sessionIds);
            const access = await runtime.encryptionAccess(AbortSignal.timeout(30_000));
            rememberComputerEncryption(access);
            if (cloud.executionNetwork !== null) {
                const encryption = await createClientPayloadEncryption(access, AbortSignal.timeout(30_000));
                observers.add(encryption);
                const terminalEvents = new Map<string, Promise<boolean>>();
                cloud.executionNetwork.observeComputer(identity.computerId, {
                    execution: async (encoded, signal) => {
                        if (decodeMessageKind(encoded) !== "native.session.result") {
                            return null;
                        }
                        const snapshot = await nativeSessionResultCodec.decode(encoded, encryption, signal);
                        if (snapshot.action !== "active-turn") {
                            throw new Error("Expected an execution snapshot");
                        }
                        return {
                            turn: snapshot.turn?.commandId ?? null,
                            lastTurn: snapshot.lastTurn?.commandId ?? null,
                            lastTurnState: snapshot.lastTurn?.state ?? null,
                            interactionPosition: snapshot.interactionState?.throughPosition ?? null,
                        };
                    },
                    terminal: (encoded, signal) => {
                        if (decodeMessageKind(encoded) !== "session.event.v2") {
                            return Promise.resolve(false);
                        }
                        let result = terminalEvents.get(encoded);
                        if (result === undefined) {
                            result = sessionEventEnvelopeCodec
                                .decode(encoded, encryption, signal)
                                .then((message) =>
                                    decodeKnownSessionLiveEventBatch(message.events).some(
                                        (event) =>
                                            event.type === "lifecycle-metadata" &&
                                            (event.payload.kind === "prompt.completed" ||
                                                event.payload.kind === "prompt.failed"),
                                    ),
                                );
                            if (terminalEvents.size >= 4096) {
                                const oldest = terminalEvents.keys().next().value;
                                if (oldest !== undefined) {
                                    terminalEvents.delete(oldest);
                                }
                            }
                            terminalEvents.set(encoded, result);
                        }
                        return result;
                    },
                });
            }
            await runtime.api.verifyAgent(agents[0]?.harness ?? "codex", AbortSignal.timeout(120_000));
            // The second client reaches the same Worker directly; only the browser uses the failing network.
            const sessionClient = async (
                target: { readonly harness: string; readonly sessionId: string },
                signal: AbortSignal,
            ) => {
                return await runtime.api.connectSession(target, signal);
            };
            return {
                failure: runtime.failure,
                continueReply: runtime.continueReply,
                readManagedSessions: (signal: AbortSignal) => runtime.api.managedSessions(signal),
                /** Archives a Session the way another browser window of this Computer would. */
                archiveSession: async (sessionId: string): Promise<void> => {
                    await runtime.api.archiveManagedSession(
                        { harness: agents[0]?.harness ?? "codex", sessionId },
                        AbortSignal.timeout(30_000),
                    );
                },
                /** Applies another client's explicit model edit through the public Relay contract. */
                selectModel: async (sessionId: string, value: string): Promise<void> => {
                    const signal = AbortSignal.timeout(30_000);
                    const target = { harness: agents[0]?.harness ?? "codex", sessionId };
                    const client = await sessionClient(target, signal);
                    try {
                        const snapshot = await client.sessions.readConfiguration(target, signal);
                        await client.sessions.updateConfiguration(
                            target,
                            {
                                configId: "model",
                                expectedConfigurationRevision: snapshot.configurationRevision,
                                value,
                                type: "select",
                            },
                            signal,
                        );
                    } finally {
                        client.close();
                    }
                },
                /** Starts a turn through the Relay, the way another Morty client of this Computer would. */
                submitTurn: async (sessionId: string, content: string): Promise<void> => {
                    const signal = AbortSignal.timeout(30000);
                    const target = { harness: agents[0]?.harness ?? "codex", sessionId };
                    const client = await sessionClient(target, signal);
                    try {
                        await client.turns.submit(
                            target,
                            { attachments: [], content, idempotencyKey: crypto.randomUUID() },
                            signal,
                        );
                    } finally {
                        client.close();
                    }
                },
                /** Restarts the Computer offering these Agents, as when the user installs or removes one. */
                replaceAgents: async (replacement: readonly ControlledAgent[]): Promise<void> => {
                    const [first, ...others] = replacement;
                    if (first === undefined) {
                        throw new Error("A controlled Computer needs at least one Agent");
                    }
                    await runtime.restartWithAgents({
                        additionalAgents: others.map((agent) => ({ harness: agent.harness, name: agent.label })),
                        harness: first.harness,
                        agentName: first.label,
                    });
                },
                /** Reads the current title through a separate client's production Computer API. */
                readSessionTitle: async (sessionId: string) => {
                    const session = await runtime.api.managedSession(
                        { harness: agents[0]?.harness ?? "codex", sessionId },
                        AbortSignal.timeout(30000),
                    );
                    return session.entry.title;
                },
                /** Renames a Session through the Relay, the way another Morty client of this Computer would. */
                renameSession: async (sessionId: string, title: string): Promise<void> => {
                    const signal = AbortSignal.timeout(30000);
                    const target = { harness: agents[0]?.harness ?? "codex", sessionId };
                    const client = await sessionClient(target, signal);
                    try {
                        await client.sessions.rename(target, title, signal);
                    } finally {
                        client.close();
                    }
                },
                disconnect: runtime.disconnect,
                reconnect: runtime.reconnect,
                /** Revokes the Computer through the Relay, as the Relay does when its credential was reused. */
                revoke: async (): Promise<void> => await cloud.revokeComputer(identity.computerId),
                writeFiles: runtime.writeFiles,
            };
        };
        return {
            computerId,
            network: cloud.network,
            sharingNetwork,
            executionNetwork: cloud.executionNetwork,
            connectAgent: async (
                agent: ControlledAgent = { harness: "claude", label: "Codex" },
                sessionIds?: ReadonlySet<string>,
            ) => await connect([agent], sessionIds),
            connectAgents: async (agents: readonly ControlledAgent[], sessionIds?: ReadonlySet<string>) =>
                await connect(agents, sessionIds),
            connectRuntime: async () => {
                const runtime = await cloud.connectAgent(identity.computerId, identity.token);
                return { failure: runtime.failure, computerId: runtime.computerId };
            },
            createTransferUrl: async () => {
                const response = await request(`v1/computers/${identity.computerId}/identity/transfers`, {
                    operationId: crypto.randomUUID(),
                });
                if (response.status !== 201) {
                    throw new Error(`Could not create a transfer link: ${response.status} ${await response.text()}`);
                }
                return v.parse(v.object({ url: v.string() }), await response.json()).url;
            },
            identity: {
                getToken: async (signal: AbortSignal): Promise<string> => {
                    signal.throwIfAborted();
                    return identity.token;
                },
                computerId: identity.computerId,
            },
            origin,
            transport,
            close: () => transport.dispose(),
        };
    };
    return {
        createApplication,
        close: async () => {
            try {
                await sharingNetwork?.close();
            } finally {
                try {
                    await cloud.close();
                } finally {
                    for (const observer of observers) {
                        observer.close();
                    }
                }
            }
        },
    };
}
