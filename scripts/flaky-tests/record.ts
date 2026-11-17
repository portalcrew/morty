import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FlakyTest {
    readonly file: string;
    readonly name: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECORD_DIRECTORY = "MORTY_FLAKY_TESTS_DIR";

const MAX_TESTS = 200;
const MAX_FILE_LENGTH = 300;
const MAX_NAME_LENGTH = 1000;
const REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

type Runner = "vitest" | "playwright";

function repositoryTests(tests: readonly FlakyTest[]): FlakyTest[] {
    return tests.map((test) => ({ file: relative(REPOSITORY_ROOT, test.file).replaceAll("\\", "/"), name: test.name }));
}

function writeRecord(file: string, tests: readonly FlakyTest[]): void {
    const directory = process.env[RECORD_DIRECTORY];
    if (directory === undefined || directory === "") {
        return;
    }
    const target = resolve(REPOSITORY_ROOT, directory);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, file), JSON.stringify({ tests }));
}

export function recordFlakyTests(runner: Runner, tests: readonly FlakyTest[]): void {
    const record = repositoryTests(tests);
    console.error(
        [
            "",
            `${record.length} test(s) failed and then passed when retried against the same code. A flaky test fails the run:`,
            ...record.map((test) => `  ${test.file} > ${test.name}`),
            "",
        ].join("\n"),
    );
    writeRecord(`${runner}-${randomUUID()}.json`, record);
}

// A test that failed every attempt in this job is flaky if a rerun of the job passes against the same code. A job that
// fails more tests than one record holds is not worth comparing: that many failures are not flakiness.
export function recordFailedTests(runner: Runner, tests: readonly FlakyTest[]): void {
    if (tests.length > 0 && tests.length <= MAX_TESTS) {
        writeRecord(`${runner}-failed-${randomUUID()}.json`, repositoryTests(tests));
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTER.test(value);
}

export function parseFlakyTestRecord(text: string): readonly FlakyTest[] {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !Array.isArray(value["tests"])) {
        throw new Error("A flaky-test record must be an object with a tests array.");
    }
    const tests: unknown[] = value["tests"];
    if (tests.length === 0 || tests.length > MAX_TESTS) {
        throw new Error(`A flaky-test record must list 1 to ${MAX_TESTS} tests.`);
    }
    return tests.map((test) => {
        if (
            !isRecord(test) ||
            !boundedText(test["file"], MAX_FILE_LENGTH) ||
            !REPOSITORY_PATH.test(test["file"]) ||
            !boundedText(test["name"], MAX_NAME_LENGTH)
        ) {
            throw new Error("A flaky test needs a repository-relative file and a bounded single-line name.");
        }
        return { file: test["file"], name: test["name"] };
    });
}
