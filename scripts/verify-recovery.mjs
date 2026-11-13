import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

// A rename must not change which repository owns accepted release history.
const repositoryId = 1456063169;
const resolvedRepository = JSON.parse(
    execFileSync("gh", ["api", `repositories/${repositoryId}`], { encoding: "utf8", timeout: 60000 }),
);
if (resolvedRepository.id !== repositoryId || !/^[^/]+\/[^/]+$/.test(resolvedRepository.full_name ?? "")) {
    throw new Error("Cannot resolve the Morty release repository");
}
const repository = resolvedRepository.full_name;
const runId = process.env.ARCHIVE_RUN_ID;
if (!/^\d+$/.test(runId ?? "")) {
    throw new Error("A numeric successful archive run is required");
}
const api = (path) =>
    JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], { encoding: "utf8", timeout: 60000 }));
const authorized = (run) =>
    run.conclusion === "success" &&
    run.head_branch === "main" &&
    run.head_repository?.id === repositoryId &&
    ["push", "workflow_dispatch"].includes(run.event);
const completed = (run, names) => {
    const result = api(`actions/runs/${run.id}/jobs?per_page=100`);
    if (result.total_count > result.jobs.length) {
        throw new Error("Incomplete job inventory");
    }
    return names.every((name) => result.jobs.some((job) => job.name === name && job.conclusion === "success"));
};
const run = api(`actions/runs/${runId}`);
if (!authorized(run)) {
    throw new Error("Archive run is not an authorized successful main run");
}
if (run.path !== ".github/workflows/morty-cli.yml" || !completed(run, ["publish", "deploy", "github-release"])) {
    throw new Error("Recovery requires a completed consolidated release chain");
}
for (const [source, name] of [[run, "morty-release"]]) {
    const inventory = api(`actions/runs/${source.id}/artifacts?per_page=100`);
    if (inventory.total_count > inventory.artifacts.length) {
        throw new Error("Incomplete archive inventory");
    }
    const matching = inventory.artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
    if (matching.length !== 1) {
        throw new Error("The original accepted archive is missing, expired or ambiguous");
    }
}
await appendFile(process.env.GITHUB_OUTPUT, `revision=${run.head_sha}\n`);
