import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import { type FlakyTest, recordFailedTests, recordFlakyTests } from "../../../scripts/flaky-tests/record.ts";

type Outcome = ReturnType<TestCase["outcome"]>;

function record(test: TestCase): FlakyTest {
    const [, project = "", , ...titles] = test.titlePath();
    return {
        file: test.location.file,
        name: [project, ...titles].filter((title) => title !== "").join(" > "),
    };
}

// `--repeat-each` runs a journey several times. One repetition failing on every try while another passes is a failure
// and a pass against the same code, as a failure its retry passes is.
function journeyResult(outcomes: ReadonlySet<Outcome>): "flaky" | "failed" | "passed" {
    if (outcomes.has("flaky") || (outcomes.has("unexpected") && outcomes.has("expected"))) {
        return "flaky";
    }
    return outcomes.has("unexpected") ? "failed" : "passed";
}

export default class FlakyTestReporter implements Reporter {
    #root: Suite | undefined;

    onBegin(_config: FullConfig, suite: Suite): void {
        this.#root = suite;
    }

    onEnd(): void {
        const journeys = new Map<string, { readonly test: FlakyTest; readonly outcomes: Set<Outcome> }>();
        for (const test of this.#root?.allTests() ?? []) {
            const journey = record(test);
            const key = `${journey.file}\n${journey.name}`;
            const entry = journeys.get(key) ?? { test: journey, outcomes: new Set<Outcome>() };
            entry.outcomes.add(test.outcome());
            journeys.set(key, entry);
        }
        const results = [...journeys.values()].map(({ test, outcomes }) => ({ test, result: journeyResult(outcomes) }));
        recordFailedTests(
            "playwright",
            results.filter(({ result }) => result === "failed").map(({ test }) => test),
        );
        const flaky = results.filter(({ result }) => result === "flaky").map(({ test }) => test);
        if (flaky.length > 0) {
            recordFlakyTests("playwright", flaky);
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
