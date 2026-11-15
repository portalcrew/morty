import type { Plugin } from "vite";
import type { Reporter, TestCase, TestModule } from "vitest/node";
import { type FlakyTest, recordFlakyTests } from "./record.ts";

// A test that passed on its retry keeps the errors of its failed attempt, which the default reporter never prints.
// They are the only evidence of why it failed, so the job log shows them, bounded.
const MAX_ERRORS = 5;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_FRAMES = 6;
// Everything a terminal or the CI log could interpret, except the line breaks that keep a message readable.
const UNPRINTABLE = /[^\P{Cc}\n\t]/gu;

function failedAttempt(test: TestCase): string[] {
    const errors = test.result().errors ?? [];
    const lines = errors.slice(0, MAX_ERRORS).flatMap((error, index) => {
        const message = `${error.name ?? "Error"}: ${error.message}`.replace(UNPRINTABLE, "");
        const frames = (error.stack ?? "")
            .split("\n")
            // Frames in the repository's own code locate the failure; the test runner's frames are the same each time.
            .filter((line) => /^\s*at /.test(line) && !/\/node_modules\/|node:internal/.test(line))
            .slice(0, MAX_STACK_FRAMES)
            .map((line) => `      ${line.trim().replace(UNPRINTABLE, "")}`);
        const bounded =
            message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)} [truncated]` : message;
        return [`    [${index + 1}/${errors.length}] ${bounded.replaceAll("\n", "\n      ")}`, ...frames];
    });
    if (errors.length > MAX_ERRORS) {
        lines.push(`    ... ${errors.length - MAX_ERRORS} more error(s)`);
    }
    return lines.length === 0 ? ["    The failed attempt reported no error."] : lines;
}

// A failed test runs once more against the same code. Passing then proves the test flaky, not the change correct, so
// the run still fails: retrying only classifies the failure, and the record lets CI track the test until it is fixed.
const flakyTestReporter: Reporter = {
    onTestRunEnd: (testModules: readonly TestModule[]) => {
        const flaky: { readonly record: FlakyTest; readonly test: TestCase }[] = [];
        for (const testModule of testModules) {
            for (const test of testModule.children.allTests()) {
                if (test.diagnostic()?.flaky === true) {
                    flaky.push({ record: { file: testModule.moduleId, name: test.fullName }, test });
                }
            }
        }
        if (flaky.length === 0) {
            return;
        }
        recordFlakyTests(
            "vitest",
            flaky.map(({ record }) => record),
        );
        console.error(
            [
                "Errors of each flaky test's failed attempt:",
                ...flaky.flatMap(({ record, test }) => [`  ${record.name}`, ...failedAttempt(test)]),
                "",
            ].join("\n"),
        );
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
