import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";

let runtime: Miniflare;
let output = "";
const written: { readonly marker: string; readonly resolve: () => void }[] = [];

function logged(marker: string): Promise<void> {
    return output.includes(marker)
        ? Promise.resolve()
        : new Promise((resolve) => {
              written.push({ marker, resolve });
          });
}

beforeAll(async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        loader: { ".txt": "text", ".sql": "text" },
        platform: "browser",
        target: "es2022",
        write: false,
    });
    const script = bundle.outputFiles[0];
    if (script === undefined) {
        throw new Error("Missing Worker bundle");
    }
    runtime = new Miniflare(
        convertV4MiniflareOptions({
            bindings: { APP_ORIGIN: "https://chat.test" },
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            modules: true,
            script: script.text,
            // The Worker's structured log stream, as the runtime records it.
            handleStructuredLogs: (log) => {
                output += `${log.message}\n`;
                for (const waiter of written.filter((entry) => output.includes(entry.marker))) {
                    written.splice(written.indexOf(waiter), 1);
                    waiter.resolve();
                }
            },
        }),
    );
    await runtime.ready;
});

afterAll(async () => runtime.dispose());

test("Given a request whose credential field is malformed, When the Worker logs the rejected request, Then the log names the field but never its value", async () => {
    const canary = "CREDENTIAL-CANARY-not-a-valid-creation-key";
    const response = await runtime.dispatchFetch("https://chat.test/morty/api/v1/computers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creationKey: canary }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST", message: "The request is invalid." } });
    await logged("Morty request failed");
    expect(output).toContain("creationKey");
    expect(output).not.toContain(canary);
});
