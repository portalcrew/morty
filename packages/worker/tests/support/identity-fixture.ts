import { fileURLToPath } from "node:url";
import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import { createResponseLossProxy } from "@morty-build/relay-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect } from "vitest";
import { createSessionExecutionProxy } from "../../../../tests/support/session-execution-proxy.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import worker from "../../src/worker/application.ts";

/** A fresh client-held key naming one anonymous user creation. */
export const anonymousCreationKey = (): string =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

import { startTestRelay } from "./test-relay.ts";

export const AUTH_TIME = new Date("2026-09-07T00:00:00.000Z");
export const APP_ORIGIN = "http://localhost:5173";

export function accountRequest(token?: string, computerId?: string): Request {
    return new Request(
        `${APP_ORIGIN}/morty/api${computerId === undefined ? "" : `/v1/computers/${computerId}`}/session`,
        {
            headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
        },
    );
}

type IdentityFixtureOptions = {
    /** Serve the Chat Worker on a free loopback port and use that origin as APP_ORIGIN. */
    readonly listenOnLoopback?: true;
    readonly loseTurnResponses?: true;
    readonly delayExecutionReads?: true;
    readonly workerEntryPoint?: string;
};

export async function createIdentityFixture(options: IdentityFixtureOptions = {}) {
    const createFixture = await prepareIdentityFixture(options);
    return createFixture();
}

/** Call in beforeAll so each suite run rebuilds its inputs, including watch reruns. */
export async function prepareIdentityFixture(options: IdentityFixtureOptions = {}) {
    const createBindings = await prepareTestMortyRelayBindings(
        options.workerEntryPoint ?? fileURLToPath(new URL("./credential-storage-worker.ts", import.meta.url)),
    );
    return () => startIdentityFixture(options, createBindings);
}

async function startIdentityFixture(
    options: IdentityFixtureOptions,
    createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>,
) {
    const relay = await startTestRelay(createBindings);
    const executionNetwork =
        options.delayExecutionReads === true ? await createSessionExecutionProxy(relay.baseUrl) : null;
    const network =
        options.loseTurnResponses === true
            ? await createResponseLossProxy(executionNetwork?.origin ?? relay.baseUrl)
            : null;
    const chatNetwork =
        options.listenOnLoopback === true
            ? await createResponseLossProxy(network?.origin ?? executionNetwork?.origin ?? relay.baseUrl)
            : null;
    try {
        const cloudflare = relay.cloudflare;
        const ready = new URL(chatNetwork?.origin ?? network?.origin ?? executionNetwork?.origin ?? relay.baseUrl);
        const baseConfiguration = {
            APP_ORIGIN: ready.origin,
        };
        await relay.configure(baseConfiguration);
        let cloudBindings = await cloudflare.getBindings();
        let computerObjects = await cloudflare.getDurableObjectNamespace("COMPUTER_RELAY");
        const computerRelays = {
            getByName: (name: string, options?: Parameters<typeof computerObjects.get>[1]) =>
                computerObjects.get(computerObjects.idFromName(name), options),
            idFromName: (name: string) => computerObjects.idFromName(name),
            get: (
                id: ReturnType<typeof computerObjects.idFromName>,
                options?: Parameters<typeof computerObjects.get>[1],
            ) => {
                const object = computerObjects.get(id, options);
                return {
                    fetch: async (request: Request) => {
                        const response = await object.fetch(request.url, {
                            method: request.method,
                            headers: [...request.headers],
                            ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
                        });
                        const hasBody = response.status !== 204 && response.status !== 205 && response.status !== 304;
                        return new Response(hasBody ? await response.arrayBuffer() : null, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: [...response.headers],
                        });
                    },
                };
            },
        };
        const environment = (appOrigin = baseConfiguration.APP_ORIGIN) => ({
            ...cloudBindings,
            ...baseConfiguration,
            APP_ORIGIN: appOrigin,
            ASSETS: { fetch: () => Promise.resolve(new Response()) },
            COMPUTER_RELAY: computerRelays,
        });
        /** Restarts the Worker with the changed deployment settings, keeping its storage. */
        const reconfigure = async () => {
            await relay.configure(baseConfiguration);
            cloudBindings = await cloudflare.getBindings();
            computerObjects = await cloudflare.getDurableObjectNamespace("COMPUTER_RELAY");
        };
        const createAnonymousUser = async () => {
            const response = await worker.fetch(
                new Request(`${APP_ORIGIN}/morty/api/v1/computers`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ creationKey: anonymousCreationKey() }),
                }),
                environment(),
            );
            expect(response.status).toBe(201);
            const identity = v.parse(
                v.object({ computerToken: v.string(), computerId: v.string() }),
                await response.json(),
            );
            return { computerId: identity.computerId, token: identity.computerToken };
        };
        return {
            reload: reconfigure,
            revokeComputer: async (computerId: string) => {
                const object = computerObjects.get(computerObjects.idFromName(computerObjectName(computerId)));
                const response = await object.fetch("https://computer.internal/revoked-computer", {
                    method: "POST",
                    body: computerId,
                    signal: AbortSignal.timeout(15_000),
                });
                expect(response.status).toBe(204);
            },
            baseConfiguration,
            network,
            executionNetwork,
            connectAgent: relay.connectAgent,
            relayRequest: relay.app.request,
            createAnonymousUser,
            dispatchFetch: cloudflare.dispatchFetch.bind(cloudflare),
            environment,
            origin: ready.origin,
            changeAppOrigin: async (origin: string) => {
                baseConfiguration.APP_ORIGIN = origin;
                await reconfigure();
            },
            close: async () => {
                await executionNetwork?.close();
                await network?.close();
                await chatNetwork?.close();
                await relay.close();
            },
        };
    } catch (cause) {
        await executionNetwork?.close();
        await network?.close();
        await chatNetwork?.close();
        await relay.close();
        throw cause;
    }
}
