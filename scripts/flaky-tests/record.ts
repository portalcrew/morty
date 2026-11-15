import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The flaky-test record is the contract between the test runners, which write it into a CI artifact, and the
// tracker, which reads that artifact back from a run it does not trust.

export interface FlakyTest {
    /** Repository-relative path of the test file. */
    readonly file: string;
    /** The test's titles from the outermost suite inward, which identify it within its file. */
    readonly name: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// CI names a repository-relative directory here and uploads it; a local run only prints.
const RECORD_DIRECTORY = "MORTY_FLAKY_TESTS_DIR";

const MAX_TESTS = 200;
const MAX_FILE_LENGTH = 300;
const MAX_NAME_LENGTH = 1000;
const REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

export function recordFlakyTests(runner: "vitest" | "playwright", tests: readonly FlakyTest[]): void {
    const record = tests.map((test) => ({
        file: relative(REPOSITORY_ROOT, test.file).replaceAll("\\", "/"),
        name: test.name,
    }));
    console.error(
        [
            "",
            `${record.length} test(s) failed and then passed when retried against the same code. A flaky test fails the run:`,
            ...record.map((test) => `  ${test.file} > ${test.name}`),
            "",
        ].join("\n"),
    );
    const directory = process.env[RECORD_DIRECTORY];
    if (directory === undefined || directory === "") {
        return;
    }
    const target = resolve(REPOSITORY_ROOT, directory);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `${runner}-${randomUUID()}.json`), JSON.stringify({ tests: record }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTER.test(value);
}

/** Decodes a record read from an artifact; anything other than a well-formed record is rejected. */
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
