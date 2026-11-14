import { createTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import { createTestOwner } from "../../../../packages/relay-test-support/src/identity-fixture.ts";
import type { FakeAgentHarnessDefinition } from "./agent-harness.ts";
import { createFakeAgentHarnessRuntime } from "./relay-agent-harness.ts";

/** Starts the production Relay boundary with isolated local Cloudflare storage. */
export async function startTestRelay() {
    const cancellation = new AbortController();
    const runtimes: AsyncDisposable[] = [];
    const bindings = await createTestMortyRelayBindings();
    try {
        const app = { request: bindings.request };
        await bindings.configure({ APP_ORIGIN: bindings.origin });
        const owners = new Map<string, string>();
        const createOwner = async () => {
            const owner = await createTestOwner(bindings.request, bindings.origin, cancellation.signal);
            owners.set(owner.computerId, owner.token);
            return owner;
        };
        const close = async (): Promise<void> => {
            cancellation.abort(new Error("Test Relay stopped"));
            try {
                await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime[Symbol.asyncDispose]()));
            } finally {
                await bindings[Symbol.asyncDispose]();
            }
        };
        return {
            app,
            baseUrl: bindings.origin,
            createOwner,
            connectAgent: async (
                computerId: string,
                harnesses?: readonly FakeAgentHarnessDefinition[],
                sessionIds?: ReadonlySet<string>,
            ) => {
                const credential = owners.get(computerId);
                if (credential === undefined) {
                    throw new Error("Create the computer owner first");
                }
                const runtime = await createFakeAgentHarnessRuntime({
                    credential,
                    ...(harnesses === undefined ? {} : { harnesses }),
                    ...(sessionIds === undefined ? {} : { sessionIds }),
                    origin: bindings.origin,
                    computerId,
                    server: app,
                    signal: cancellation.signal,
                });
                runtimes.push(runtime);
                return runtime;
            },
            close,
            [Symbol.asyncDispose]: close,
        };
    } catch (cause) {
        cancellation.abort(cause);
        await bindings[Symbol.asyncDispose]();
        throw cause;
    }
}
