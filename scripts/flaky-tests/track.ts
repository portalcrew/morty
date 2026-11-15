import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FlakyTest, parseFlakyTestRecord } from "./record.ts";

// Records each flaky test found by a failed pipeline run on one issue per test: the first occurrence opens the
// issue, later ones add a comment, and an occurrence after the issue was closed reopens it. The artifacts come from
// the tested code, so they are only read as data and validated; everything else comes from GitHub's run event.

// flaky-tests.yml downloads the run's records here.
const ARTIFACTS_DIRECTORY = fileURLToPath(new URL("../../test-results/flaky-test-artifacts", import.meta.url));
const GITHUB_API = "https://api.github.com";
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const LABEL = "flaky-test";
const MAX_RECORD_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
// Written by morty-pipeline.yml as flaky-tests-<attempt>-<job>[-<shard>].
const ARTIFACT_NAME = /^flaky-tests-(\d+)-([a-z]+)(?:-(\d+))?$/;
const RECORD_FILE = /^(?:vitest|playwright)-[\da-f-]{36}\.json$/;

interface Run {
    readonly url: string;
    readonly attempt: string;
    readonly event: string;
    readonly headSha: string;
}

interface Occurrence {
    readonly test: FlakyTest;
    readonly jobs: readonly string[];
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
    if (!REPOSITORY.test(repository)) {
        throw new Error("GITHUB_REPOSITORY must name one repository as owner/name.");
    }
    return async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> => {
        const response = await fetch(`${GITHUB_API}/repos/${repository}${path}`, {
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

function readOccurrences(directory: string, attempt: string): readonly Occurrence[] {
    const byTest = new Map<string, { test: FlakyTest; jobs: Set<string> }>();
    // A run whose failures were all consistent uploads no record, so nothing is downloaded.
    if (!existsSync(directory)) {
        return [];
    }
    for (const artifact of readdirSync(directory, { withFileTypes: true })) {
        const name = ARTIFACT_NAME.exec(artifact.name);
        if (!artifact.isDirectory() || name === null || name[1] !== attempt || name[2] === undefined) {
            throw new Error(`Unexpected artifact ${JSON.stringify(artifact.name)} for attempt ${attempt}.`);
        }
        const job = name[3] === undefined ? name[2] : `${name[2]} (${name[3]})`;
        for (const file of readdirSync(join(directory, artifact.name), { withFileTypes: true })) {
            const path = join(directory, artifact.name, file.name);
            if (!file.isFile() || !RECORD_FILE.test(file.name)) {
                throw new Error(`Unexpected file ${JSON.stringify(file.name)} in artifact ${artifact.name}.`);
            }
            for (const test of parseFlakyTestRecord(readRecord(path))) {
                const key = testKey(test);
                const entry = byTest.get(key) ?? { test, jobs: new Set<string>() };
                entry.jobs.add(job);
                byTest.set(key, entry);
            }
        }
    }
    return [...byTest.values()].map(({ test, jobs }) => ({ test, jobs: [...jobs].sort() }));
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
        "The run that found it failed. Each occurrence is listed in the comments below.",
        "",
        `- **File:** [${code(test.file)}](${fileUrl})`,
        `- **Test:** ${code(test.name)}`,
        "",
        "Fix the cause, then close this issue. A later flaky failure of the same test reopens it.",
        "",
        marker(test),
    ].join("\n");
}

function occurrenceComment(run: Run, jobs: readonly string[]): string {
    return `Flaky in [this run](${run.url}/attempts/${run.attempt}) (attempt ${run.attempt}, ${code(run.event)}, ${code(run.headSha.slice(0, 12))}), job ${jobs.map(code).join(", ")}.`;
}

async function track(github: GitHub, serverRepositoryUrl: string, run: Run, occurrences: readonly Occurrence[]) {
    await ensureLabel(github);
    const issues = await listTrackedIssues(github);
    for (const { test, jobs } of occurrences) {
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
        await github("POST", `/issues/${number}/comments`, { body: occurrenceComment(run, jobs) });
    }
}

const run: Run = {
    url: requiredEnvironment("RUN_URL"),
    attempt: requiredEnvironment("RUN_ATTEMPT"),
    event: requiredEnvironment("RUN_EVENT"),
    headSha: requiredEnvironment("RUN_HEAD_SHA"),
};
const occurrences = readOccurrences(ARTIFACTS_DIRECTORY, run.attempt);
if (occurrences.length === 0) {
    console.log("No flaky tests were recorded by this run.");
} else {
    const repository = requiredEnvironment("GITHUB_REPOSITORY");
    await track(
        createGitHub(repository, requiredEnvironment("GITHUB_TOKEN")),
        `https://github.com/${repository}`,
        run,
        occurrences,
    );
}
