import { resolve } from "node:path";
import { MortyClient, WsTransport } from "@morty-build/client";
import * as v from "valibot";
import type { ControlledAgent } from "../../../../tests/support/fake-daemon/runtime.ts";
import { createResponseLossProxy } from "../../../relay-test-support/src/response-loss-proxy.ts";
import { createIdentityFixture } from "../../../worker/tests/support/identity-fixture.ts";
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
            const setup = await request(`v1/computers/${identity.computerId}/setup`, {
                harness: agents[0]?.harness ?? "codex",
            });
            if (setup.status !== 202) {
                throw new Error(`Could not prepare the test Computer: ${setup.status} ${await setup.text()}`);
            }
            // The second client reaches the same Worker directly; only the browser uses the failing network.
            const sessionClient = async (
                target: { readonly harness: string; readonly sessionId: string },
                signal: AbortSignal,
            ) => {
                const response = await cloud.dispatchFetch(
                    `${cloud.directOrigin}/morty/api/v1/computers/${runtime.computerId}/native-sessions/access`,
                    {
                        method: "POST",
                        signal,
                        headers: {
                            authorization: `Bearer ${identity.token}`,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(target),
                    },
                );
                if (!response.ok) {
                    throw new Error(`Could not authorize the second client: ${response.status}`);
                }
                const access = v.parse(v.object({ credential: v.string() }), await response.json());
                signal.throwIfAborted();
                const transport = new WsTransport();
                return new MortyClient({
                    transport,
                    onClose: transport.close,
                    endpoint: cloud.directOrigin,
                    computerId: runtime.computerId,
                    credentialProvider: {
                        credential: async (signal: AbortSignal) => {
                            signal.throwIfAborted();
                            return access.credential;
                        },
                    },
                });
            };
            return {
                failure: runtime.failure,
                continueReply: runtime.continueReply,
                /** Archives a Session the way another browser window of this Computer would. */
                archiveSession: async (sessionId: string): Promise<void> => {
                    const response = await request(`v1/computers/${identity.computerId}/managed-sessions/archive`, {
                        harness: agents[0]?.harness ?? "codex",
                        sessionId,
                    });
                    if (response.status !== 200) {
                        throw new Error(`Could not archive the test Session: ${response.status}`);
                    }
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
                                booleanValue: false,
                                configId: "model",
                                expectedConfigurationRevision: snapshot.configurationRevision,
                                value,
                                valueType: "select",
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
                await cloud.close();
            }
        },
    };
}
