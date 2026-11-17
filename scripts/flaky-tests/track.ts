import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FlakyTest, parseFlakyTestRecord } from "./record.ts";

// Records each flaky test found by a pipeline run on one issue per test: the first occurrence opens the issue, later
// ones add a comment, and an occurrence after the issue was closed reopens it. A test is flaky when it failed and then
// passed against the same code: on its retry within a job, or when the job that failed it passes on a rerun of the
// run. The artifacts come from the tested code, so they are only read as data and validated; everything else comes
// from GitHub's run event and API.

const ARTIFACTS_DIRECTORY = fileURLToPath(new URL("../../test-results/flaky-test-artifacts", import.meta.url));
const PREVIOUS_ARTIFACTS_DIRECTORY = fileURLToPath(
    new URL("../../test-results/flaky-test-artifacts-previous", import.meta.url),
);
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const LABEL = "flaky-test";
const MAX_RECORD_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const JOB_DIRECTORY = /^([a-z]+)(?:-(\d+))?$/;
const RECORD_FILE = /^(?:vitest|playwright)(-failed)?-[\da-f-]{36}\.json$/;

interface Run {
    readonly id: string;
    readonly url: string;
    readonly attempt: number;
    readonly event: string;
    readonly headSha: string;
}

interface JobRecords {
    readonly flaky: FlakyTest[];
    readonly failed: FlakyTest[];
}

interface Occurrence {
    readonly test: FlakyTest;
    /** Jobs whose own retry passed the test in this attempt. */
    readonly retried: readonly string[];
    /** Jobs that failed the test in the previous attempt and passed when rerun in this one. */
    readonly rerun: readonly string[];
}

interface Issue {
    readonly number: number;
    readonly state: "open" | "closed";
    readonly body: string;
}

class GitHubRequestError extends Error {
    readonly status: number;
    readonly code: string | undefined;

    constructor(method: string, path: string, status: number, code: string | undefined) {
        super(`GitHub ${method} ${path} failed with HTTP ${status}${code === undefined ? "" : ` (${code})`}.`);
        this.name = "GitHubRequestError";
        this.status = status;
        this.code = code;
    }
}

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`${name} is required.`);
    }
    return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstErrorCode(body: unknown): string | undefined {
    if (!isRecord(body) || !Array.isArray(body["errors"])) {
        return undefined;
    }
    const [first]: unknown[] = body["errors"];
    return isRecord(first) && typeof first["code"] === "string" ? first["code"] : undefined;
}

function createGitHub(repository: string, token: string) {
    const [owner, name] = repository.split("/");
    if (!REPOSITORY.test(repository) || owner === undefined || name === undefined) {
        throw new Error("GITHUB_REPOSITORY must name one repository as owner/name.");
    }
    const repositoryPath = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    return async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> => {
        const response = await fetch(`https://api.github.com/repos/${repositoryPath}${path}`, {
            method,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        const decoded: unknown = text === "" ? undefined : JSON.parse(text);
        if (!response.ok) {
            throw new GitHubRequestError(method, path, response.status, firstErrorCode(decoded));
        }
        return decoded;
    };
}

type GitHub = ReturnType<typeof createGitHub>;

// Size and type are checked on the descriptor that is read, so a file swapped after the check is never read.
function readRecord(path: string): string {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (!fstatSync(descriptor).isFile()) {
            throw new Error(`${path} is not a regular file.`);
        }
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const length = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (length > MAX_RECORD_BYTES) {
            throw new Error(`${path} exceeds ${MAX_RECORD_BYTES} bytes.`);
        }
        return buffer.subarray(0, length).toString("utf8");
    } finally {
        closeSync(descriptor);
    }
}

function readRecords(directory: string): ReadonlyMap<string, JobRecords> {
    const byJob = new Map<string, JobRecords>();
    // A run whose jobs recorded nothing uploads no record, so nothing is downloaded.
    if (!existsSync(directory)) {
        return byJob;
    }
    for (const jobDirectory of readdirSync(directory, { withFileTypes: true })) {
        const name = JOB_DIRECTORY.exec(jobDirectory.name);
        if (!jobDirectory.isDirectory() || name === null || name[1] === undefined) {
            throw new Error(`Unexpected entry ${JSON.stringify(jobDirectory.name)} among the downloaded records.`);
        }
        const job = name[2] === undefined ? name[1] : `${name[1]} (${name[2]})`;
        const records = byJob.get(job) ?? { flaky: [], failed: [] };
        byJob.set(job, records);
        for (const file of readdirSync(join(directory, jobDirectory.name), { withFileTypes: true })) {
            const path = join(directory, jobDirectory.name, file.name);
            const kind = RECORD_FILE.exec(file.name);
            if (!file.isFile() || kind === null) {
                throw new Error(`Unexpected file ${JSON.stringify(file.name)} in the records of ${jobDirectory.name}.`);
            }
            (kind[1] === undefined ? records.flaky : records.failed).push(...parseFlakyTestRecord(readRecord(path)));
        }
    }
    return byJob;
}

function decodeJobs(value: unknown): readonly { readonly name: string; readonly conclusion: unknown }[] {
    if (!isRecord(value) || !Array.isArray(value["jobs"])) {
        throw new Error("GitHub returned an unexpected job list.");
    }
    const jobs: unknown[] = value["jobs"];
    return jobs.map((job) => {
        if (!isRecord(job) || typeof job["name"] !== "string") {
            throw new Error("GitHub returned an unexpected job.");
        }
        return { name: job["name"], conclusion: job["conclusion"] };
    });
}

// A rerun attempt lists every job of the run: the ones it reran and, unchanged, the ones that had already passed.
async function passedJobs(github: GitHub, run: Run): Promise<ReadonlySet<string>> {
    const names: string[] = [];
    for (let page = 1; ; page += 1) {
        const batch = decodeJobs(
            await github("GET", `/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`),
        );
        names.push(...batch.filter((job) => job.conclusion === "success").map((job) => job.name));
        if (batch.length < 100) {
            return new Set(names);
        }
    }
}

// Record directories name the matrix job (`web (4)`); GitHub names it within its calling workflow (`pipeline / web (4)`).
function jobPassed(passed: ReadonlySet<string>, job: string): boolean {
    return [...passed].some((name) => name === job || name.endsWith(` / ${job}`));
}

function collectOccurrences(
    current: ReadonlyMap<string, JobRecords>,
    previous: ReadonlyMap<string, JobRecords>,
    passed: ReadonlySet<string>,
): readonly Occurrence[] {
    const byTest = new Map<string, { test: FlakyTest; retried: Set<string>; rerun: Set<string> }>();
    const add = (test: FlakyTest, job: string, kind: "retried" | "rerun"): void => {
        const key = testKey(test);
        const entry = byTest.get(key) ?? { test, retried: new Set<string>(), rerun: new Set<string>() };
        entry[kind].add(job);
        byTest.set(key, entry);
    };
    for (const [job, records] of current) {
        for (const test of records.flaky) {
            add(test, job, "retried");
        }
    }
    for (const [job, records] of previous) {
        if (jobPassed(passed, job)) {
            for (const test of records.failed) {
                add(test, job, "rerun");
            }
        }
    }
    return [...byTest.values()].map(({ test, retried, rerun }) => ({
        test,
        retried: [...retried].sort(),
        rerun: [...rerun].sort(),
    }));
}

function testKey(test: FlakyTest): string {
    return createHash("sha256").update(`${test.file}\n${test.name}`).digest("hex");
}

function marker(test: FlakyTest): string {
    return `<!-- morty-flaky-test: ${testKey(test)} -->`;
}

// Inline code keeps names from rendering as Markdown or mentioning anyone.
function code(text: string): string {
    return `\`${text.replaceAll("`", "'")}\``;
}

async function ensureLabel(github: GitHub): Promise<void> {
    try {
        await github("POST", "/labels", {
            name: LABEL,
            color: "fbca04",
            description: "A test that failed and then passed against the same code",
        });
    } catch (error) {
        if (!(error instanceof GitHubRequestError && error.status === 422 && error.code === "already_exists")) {
            throw error;
        }
    }
}

function decodeIssues(value: unknown): readonly Issue[] {
    if (!Array.isArray(value)) {
        throw new Error("GitHub returned an unexpected issue list.");
    }
    const items: unknown[] = value;
    return items.flatMap((item): Issue[] => {
        if (!isRecord(item) || "pull_request" in item) {
            return [];
        }
        const { number, state, body } = item;
        if (typeof number !== "number" || (state !== "open" && state !== "closed")) {
            throw new Error("GitHub returned an unexpected issue.");
        }
        return [{ number, state, body: typeof body === "string" ? body : "" }];
    });
}

async function listTrackedIssues(github: GitHub): Promise<readonly Issue[]> {
    const issues: Issue[] = [];
    for (let page = 1; ; page += 1) {
        const batch: unknown = await github("GET", `/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
        if (!Array.isArray(batch)) {
            throw new Error("GitHub returned an unexpected issue list.");
        }
        issues.push(...decodeIssues(batch));
        if (batch.length < 100) {
            return issues;
        }
    }
}

function issueBody(test: FlakyTest, fileUrl: string): string {
    return [
        "A test failed and then passed when retried against the same code, so its result does not depend only on the code.",
        "Each occurrence is listed in the comments below.",
        "",
        `- **File:** [${code(test.file)}](${fileUrl})`,
        `- **Test:** ${code(test.name)}`,
        "",
        "Fix the cause, then close this issue. A later flaky failure of the same test reopens it.",
        "",
        marker(test),
    ].join("\n");
}

function occurrenceComment(run: Run, { retried, rerun }: Occurrence): string {
    const context = `${code(run.event)}, ${code(run.headSha.slice(0, 12))}`;
    const lines: string[] = [];
    if (retried.length > 0) {
        lines.push(
            `Flaky in [this run](${run.url}/attempts/${run.attempt}) (attempt ${run.attempt}, ${context}), job ${retried.map(code).join(", ")}.`,
        );
    }
    if (rerun.length > 0) {
        lines.push(
            `Failed in [attempt ${run.attempt - 1}](${run.url}/attempts/${run.attempt - 1}) and passed when job ${rerun.map(code).join(", ")} was rerun in [attempt ${run.attempt}](${run.url}/attempts/${run.attempt}) (${context}).`,
        );
    }
    return lines.join("\n\n");
}

async function track(github: GitHub, serverRepositoryUrl: string, run: Run, occurrences: readonly Occurrence[]) {
    await ensureLabel(github);
    const issues = await listTrackedIssues(github);
    for (const occurrence of occurrences) {
        const { test } = occurrence;
        // A concurrent run may have opened a second issue for the test; the oldest one stays the record.
        const existing = issues
            .filter((issue) => issue.body.includes(marker(test)))
            .sort((left, right) => left.number - right.number)[0];
        let number: number;
        if (existing === undefined) {
            const created = await github("POST", "/issues", {
                title: `Flaky test: ${test.name}`.slice(0, 200),
                body: issueBody(test, `${serverRepositoryUrl}/blob/${run.headSha}/${test.file}`),
                labels: [LABEL],
            });
            if (!isRecord(created) || typeof created["number"] !== "number") {
                throw new Error("GitHub returned an unexpected issue.");
            }
            number = created["number"];
            console.log(`Opened #${number} for ${test.file} > ${test.name}`);
        } else {
            number = existing.number;
            if (existing.state === "closed") {
                await github("PATCH", `/issues/${number}`, { state: "open", state_reason: "reopened" });
                console.log(`Reopened #${number} for ${test.file} > ${test.name}`);
            }
        }
        await github("POST", `/issues/${number}/comments`, { body: occurrenceComment(run, occurrence) });
    }
}

const attempt = Number(requiredEnvironment("RUN_ATTEMPT"));
if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("RUN_ATTEMPT must be a positive integer.");
}
const runId = requiredEnvironment("RUN_ID");
if (!/^\d+$/.test(runId)) {
    throw new Error("RUN_ID must be a numeric run ID.");
}
const run: Run = {
    id: runId,
    url: requiredEnvironment("RUN_URL"),
    attempt,
    event: requiredEnvironment("RUN_EVENT"),
    headSha: requiredEnvironment("RUN_HEAD_SHA"),
};
const current = readRecords(ARTIFACTS_DIRECTORY);
const previous = attempt > 1 ? readRecords(PREVIOUS_ARTIFACTS_DIRECTORY) : new Map<string, JobRecords>();
const repository = requiredEnvironment("GITHUB_REPOSITORY");
const github = createGitHub(repository, requiredEnvironment("GITHUB_TOKEN"));
const rerunCandidates = [...previous.values()].some((records) => records.failed.length > 0);
const occurrences = collectOccurrences(
    current,
    previous,
    rerunCandidates ? await passedJobs(github, run) : new Set<string>(),
);
if (occurrences.length === 0) {
    console.log("No flaky tests were recorded by this run.");
} else {
    await track(github, `https://github.com/${repository}`, run, occurrences);
}
