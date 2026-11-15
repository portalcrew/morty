import { configDefaults, defineConfig } from "vitest/config";
import { flakyTests } from "./scripts/flaky-tests/vitest.ts";

export default defineConfig({
    plugins: [flakyTests()],
    resolve: { conditions: ["morty-source"] },
    test: {
        exclude: [...configDefaults.exclude, "packages/cli/tests/**"],
        fileParallelism: true,
        maxWorkers: 4,
        include: ["packages/*/tests/**/*.contract.test.ts", "packages/*/tests/**/*.integration.test.ts"],
        testTimeout: 15_000,
    },
});
