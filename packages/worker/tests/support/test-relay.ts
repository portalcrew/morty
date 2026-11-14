import { createTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import { type ControlledAgent, createControlledAgentRuntime } from "../../../../tests/support/fake-daemon/runtime.ts";
import { mortyFiles, mortyReply } from "../../../../tests/support/fake-daemon/scenarios.ts";

/** Starts the production Relay boundary with isolated local Cloudflare storage. */
export async function startTestRelay(
    createBindings: typeof createTestMortyRelayBindings = createTestMortyRelayBindings,
) {
    const cancellation = new AbortController();
    const runtimes: AsyncDisposable[] = [];
    const bindings = await createBindings();
    try {
        const app = { request: bindings.request };
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
            cloudflare: bindings.cloudflare,
            configure: bindings.configure,
            connectAgent: async (
                computerId: string,
                token: string,
                agents: readonly ControlledAgent[] = [{ harness: "codex", label: "Codex" }],
                sessionIds?: ReadonlySet<string>,
            ) => {
                const runtime = await createControlledAgentRuntime({
                    credential: token,
                    behavior: {
                        reply: agents[0]?.reply ?? mortyReply,
                        files: mortyFiles,
                        harness: agents[0]?.harness ?? "codex",
                        agentName: agents[0]?.label ?? "Codex",
                        echoUserMessage: true,
                        additionalAgents: agents
                            .slice(1)
                            .map((agent) => ({ harness: agent.harness, name: agent.label })),
                        beforeSessionCreated: agents[0]?.beforeSessionCreated,
                        beforeSessionsListed: agents[0]?.beforeSessionsListed,
                        beforeCancellationApplied: agents[0]?.beforeCancellationApplied,
                        onBackgroundPermissionReady: agents[0]?.onBackgroundPermissionReady,
                        ...(agents[0]?.beforeConfigurationApplied === undefined
                            ? {}
                            : { beforeConfigurationApplied: agents[0].beforeConfigurationApplied }),
                        ...(sessionIds === undefined ? {} : { sessionIds }),
                    },
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
