import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

export default defineConfig({
    // Let Node strip dependency types without rewriting native class-field semantics.
    build: {
        external: [
            "**/packages/cli/**",
            `${realpathSync(fileURLToPath(new URL("../cli", import.meta.url))).replaceAll("\\", "/")}/**`,
        ],
    },
    testDir: ".",
    testMatch: ["*.e2e.test.ts", "*.browser-contract.test.ts"],
    globalSetup: "./infra/global-setup.ts",
    fullyParallel: true,
    // Each journey starts a Wrangler Worker and a local Computer.
    workers: 1,
    // A failed journey runs once more against the same code. Passing then proves it flaky, not the change correct, so
    // the run still fails and the flaky-test reporter records the journey for CI to track.
    retries: 1,
    failOnFlakyTests: true,
    // A journey takes under a minute (p99 40 s, longest 59 s across 1,272 recent CI runs): three minutes fails a hung
    // one instead of holding its shard for ten.
    timeout: Number(process.env["MORTY_E2E_TIMEOUT_MS"] ?? 180_000),
    expect: { timeout: 30000 },
    // An action whose target never becomes actionable fails as an assertion does, instead of holding the shard until
    // the journey's timeout.
    use: { actionTimeout: 30000 },
    reporter: [["list"], ["./infra/flaky-test-reporter.ts"]],
});
