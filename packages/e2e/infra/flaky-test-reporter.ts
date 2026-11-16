import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";
import { recordFlakyTests } from "../../../scripts/flaky-tests/record.ts";

export default class FlakyTestReporter implements Reporter {
    #root: Suite | undefined;

    onBegin(_config: FullConfig, suite: Suite): void {
        this.#root = suite;
    }

    onEnd(): void {
        const flaky = (this.#root?.allTests() ?? [])
            .filter((test) => test.outcome() === "flaky")
            .map((test) => {
                const [, project = "", , ...titles] = test.titlePath();
                return {
                    file: test.location.file,
                    name: [project, ...titles].filter((title) => title !== "").join(" > "),
                };
            });
        if (flaky.length > 0) {
            recordFlakyTests("playwright", flaky);
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
