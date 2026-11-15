import { defineConfig } from "vitest/config";
import { flakyTests } from "../../scripts/flaky-tests/vitest.ts";

export default defineConfig({
    plugins: [flakyTests()],
    resolve: { conditions: ["morty-source"] },
    test: {
        fileParallelism: true,
        maxWorkers: 4,
        include: [
            "tests/{sessions,runtime}/**/*.{contract,integration}.test.ts",
            "tests/agents/**/*.integration.test.ts",
        ],
        testTimeout: 120_000,
    },
});
