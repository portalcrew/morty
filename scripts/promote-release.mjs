import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { releaseVersion, verifiedRelease } from "./release-artifact.mjs";

// The merge queue tests the exact commit that becomes main and builds its release
// archive. Release that archive instead of rebuilding and retesting the same source.
const repositoryId = 1456063169;
const repository = process.env.GITHUB_REPOSITORY;
const revision = process.env.GITHUB_SHA;
const run = process.env.GITHUB_RUN_ID;
if (!/^[^/]+\/[^/]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/.test(revision ?? "") || !/^\d+$/.test(run ?? "")) {
    throw new Error("A main release workflow run is required");
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));
const archives = (runId) => {
    const inventory = api(`actions/runs/${runId}/artifacts?name=morty-release&per_page=100`);
    if (inventory.total_count > inventory.artifacts.length) {
        throw new Error("Incomplete archive inventory");
    }
    return inventory.artifacts;
};
const output = (values) =>
    appendFile(
        process.env.GITHUB_OUTPUT,
        Object.entries(values)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
    );

const queued = api(`actions/workflows/morty-ci.yml/runs?head_sha=${revision}&event=merge_group&per_page=100`);
if (queued.total_count > queued.workflow_runs.length) {
    throw new Error("Incomplete merge queue inventory");
}
// ci-ok is the merge queue's required check; main only advances to commits it accepted.
const accepted = queued.workflow_runs.filter((candidate) => {
    if (
        candidate.head_sha !== revision ||
        candidate.head_repository?.id !== repositoryId ||
        !candidate.head_branch?.startsWith("gh-readonly-queue/main/")
    ) {
        return false;
    }
    const jobs = api(`actions/runs/${candidate.id}/jobs?filter=latest&per_page=100`);
    if (jobs.total_count > jobs.jobs.length) {
        throw new Error("Incomplete job inventory");
    }
    return jobs.jobs.some((job) => job.name === "ci-ok" && job.conclusion === "success");
});
if (accepted.length > 1) {
    throw new Error("Multiple merge queue runs accepted this revision");
}
const [source] = accepted;
const candidates = source ? archives(source.id) : [];
if (candidates.some((artifact) => artifact.expired) || candidates.length > 1) {
    throw new Error("The accepted archive is expired or ambiguous");
}
if (candidates.length === 0) {
    // Markdown-only changes, manual runs and direct pushes have no accepted archive.
    console.log("No merge queue archive accepted this revision; the release chain builds and tests it.");
    await output({ "run-id": "", upload: false });
    process.exit(0);
}
gh("run", "download", String(source.id), "--repo", repository, "--name", "morty-release", "--dir", ".release");
const release = await verifiedRelease();
if (release.version !== (await releaseVersion())) {
    throw new Error("The accepted archive does not carry this revision's release version");
}
const cloud = JSON.parse(await readFile(".release/cloud/release.json", "utf8"));
if (
    cloud.revision !== release.revision ||
    cloud.cliVersion !== release.version ||
    cloud.cliRelease?.integrity !== release.integrity
) {
    throw new Error("Cloud and CLI release identities differ");
}
// A retried release keeps the archive it already promoted and possibly published.
const promoted = archives(run);
if (promoted.some((artifact) => artifact.expired) || promoted.length > 1) {
    throw new Error("Release archive is ambiguous or expired; never rebuild a published release");
}
if (promoted.length === 1) {
    gh("run", "download", run, "--repo", repository, "--name", "morty-release", "--dir", ".promoted");
    if ((await readFile(".promoted/release.json", "utf8")) !== (await readFile(".release/release.json", "utf8"))) {
        throw new Error("This run already holds a different release archive");
    }
}
console.log(`Promoting ${release.name}@${release.version} accepted by merge queue run ${source.id}`);
await output({ "run-id": source.id, upload: promoted.length === 0 });
