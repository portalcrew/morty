import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { flakyTests } from "../../scripts/flaky-tests/vitest.ts";

export default defineConfig({
    plugins: [flakyTests()],
    resolve: {
        // In-process ACP endpoints and the real daemon share the SDK's builder symbols.
        dedupe: ["@agentclientprotocol/sdk"],
        alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    },
    test: {
        environment: "./tests/infra/http-environment.ts",
        // Retain diagnostics for failures without streaming every real-service event to CI.
        silent: "passed-only",
        environmentOptions: {
            happyDOM: {
                settings: {
                    // The page and the Relay differ only by port here, so happy-dom preflights the Relay's file
                    // reads. Its preflight lists CORS-safelisted headers such as Accept, which browsers leave out,
                    // and the Relay rightly refuses them. Browsers send these reads, so the tests do too.
                    fetch: { disableSameOriginPolicy: true },
                },
            },
        },
        // Each file owns real Chat and Relay isolates. Bound their concurrent startup.
        maxWorkers: 2,
        include: ["tests/**/*.integration.test.tsx"],
        // Scenarios start real isolates, and the harness waits up to 12 s for a view (`waitForView`) and 10 s for the
        // WebSocket bridge. The test budget must outlast those waits so a stuck wait fails with what it waited for.
        testTimeout: 30_000,
    },
});
