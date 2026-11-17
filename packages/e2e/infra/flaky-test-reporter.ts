import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import { recordFailedTests, recordFlakyTests } from "../../../scripts/flaky-tests/record.ts";

function record(test: TestCase) {
    const [, project = "", , ...titles] = test.titlePath();
    return {
        file: test.location.file,
        name: [project, ...titles].filter((title) => title !== "").join(" > "),
    };
}

export default class FlakyTestReporter implements Reporter {
    #root: Suite | undefined;

    onBegin(_config: FullConfig, suite: Suite): void {
        this.#root = suite;
    }

    onEnd(): void {
        const tests = this.#root?.allTests() ?? [];
        recordFailedTests("playwright", tests.filter((test) => test.outcome() === "unexpected").map(record));
        const flaky = tests.filter((test) => test.outcome() === "flaky").map(record);
        if (flaky.length > 0) {
            recordFlakyTests("playwright", flaky);
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
