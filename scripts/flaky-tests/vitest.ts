import type { Plugin } from "vite";
import type { Reporter, TestModule } from "vitest/node";
import { type FlakyTest, recordFlakyTests } from "./record.ts";

// A failed test runs once more against the same code. Passing then proves the test flaky, not the change correct, so
// the run still fails: retrying only classifies the failure, and the record lets CI track the test until it is fixed.
const flakyTestReporter: Reporter = {
    onTestRunEnd: (testModules: readonly TestModule[]) => {
        const flaky: FlakyTest[] = [];
        for (const testModule of testModules) {
            for (const test of testModule.children.allTests()) {
                if (test.diagnostic()?.flaky === true) {
                    flaky.push({ file: testModule.moduleId, name: test.fullName });
                }
            }
        }
        if (flaky.length === 0) {
            return;
        }
        recordFlakyTests("vitest", flaky);
        process.exitCode = 1;
    },
};

export const flakyTests = (): Plugin => ({
    name: "morty:flaky-tests",
    config: () => ({ test: { retry: 1 } }),
    configureVitest: ({ vitest }) => {
        if (!vitest.config.reporters.includes(flakyTestReporter)) {
            vitest.config.reporters.push(flakyTestReporter);
        }
    },
});
