import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { flakyTests } from "../../scripts/flaky-tests/vitest.ts";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("../relay-test-support/wrangler.test.jsonc", import.meta.url));

export default defineConfig({
    root: packageDirectory,
    plugins: [
        flakyTests(),
        cloudflareTest({
            wrangler: { configPath: wranglerConfigPath },
            miniflare: { bindings: { MORTY_ALLOWED_ORIGINS: '["*"]' } },
        }),
    ],
    test: {
        include: ["tests/relay/**/*.integration.test.ts"],
        // CI shares runner resources with the other pipeline jobs.
        testTimeout: 30_000,
    },
});
