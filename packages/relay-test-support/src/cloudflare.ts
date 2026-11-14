import { fileURLToPath, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

import { miniflareDurableObjects } from "./miniflare-durable-objects.ts";

/** Prepare once per suite run; only immutable code is shared, never a runtime or its storage. */
export async function prepareTestMortyRelayBindings(workerEntryPoint?: string) {
    const bundle = await build({
        entryPoints: [workerEntryPoint ?? fileURLToPath(new NodeURL("./worker-entry.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:*", "node:*"],
        loader: { ".txt": "text", ".sql": "text" },
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the Relay Worker bundle");
    }
    const script = output.text;
    return () => createRelayBindings(script);
}

/** Owns the real Cloudflare adapters for Computer/Worker integration scenarios. */
function createCloudflareRuntime(script: string) {
    const options = {
        name: "morty-test-relay",
        modules: true,
        script,
        compatibilityDate: "2026-09-07",
        compatibilityFlags: ["nodejs_compat"],
        ratelimits: {
            ANONYMOUS_CREATION_LIMITER: { namespace_id: "103001", simple: { limit: 1_000, period: 60 } },
        },
        bindings: {
            MORTY_ALLOWED_ORIGINS: JSON.stringify(["*"]),
            MORTY_SESSION_SIGNING_SECRET: "local-development-only-session-signing-secret",
        },
        durableObjects: miniflareDurableObjects(new NodeURL("../wrangler.test.jsonc", import.meta.url)),
    } satisfies Parameters<typeof convertV4MiniflareOptions>[0];
    const runtime = new Miniflare(convertV4MiniflareOptions(options));
    return {
        runtime,
        configure: async (bindings: Readonly<Record<string, string>>) => {
            const origin = await runtime.ready;
            await runtime.setOptions(
                convertV4MiniflareOptions({
                    ...options,
                    host: origin.hostname,
                    port: Number.parseInt(origin.port, 10),
                    bindings: { ...options.bindings, ...bindings },
                }),
            );
        },
    };
}

export async function createTestMortyRelayBindings() {
    const createBindings = await prepareTestMortyRelayBindings();
    return createBindings();
}

async function createRelayBindings(script: string) {
    const { runtime, configure } = createCloudflareRuntime(script);
    try {
        const ready = await runtime.ready;
        const env = await runtime.getBindings();
        const request = async (input: Request): Promise<Response> => {
            const body = input.body === null ? undefined : await input.arrayBuffer();
            const result = await runtime.dispatchFetch(input.url, {
                method: input.method,
                headers: Object.fromEntries(input.headers),
                ...(body === undefined ? {} : { body }),
            });
            const hasBody = result.status !== 204 && result.status !== 205 && result.status !== 304;
            return new Response(hasBody ? await result.arrayBuffer() : null, {
                status: result.status,
                statusText: result.statusText,
                headers: Object.fromEntries(result.headers),
            });
        };
        return {
            env,
            origin: ready.origin,
            request,
            configure,
            cloudflare: runtime,
            [Symbol.asyncDispose]: () => runtime.dispose(),
        };
    } catch (cause) {
        await runtime.dispose();
        throw cause;
    }
}
