import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

// Releases run one at a time, and each release ships every earlier main commit. Release only the newest main commit,
// and only when it changes something that ships since the production release.
const repository = process.env.GITHUB_REPOSITORY;
const revision = process.env.GITHUB_SHA;
if (!/^[^/]+\/[^/]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/.test(revision ?? "")) {
    throw new Error("A main release workflow run is required");
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 30000 });

// Documentation, repository automation and tests never reach a release artifact.
const unshipped = [
    /\.(md|markdown|mdx)$/i,
    /^\.github\//,
    /^\.gitignore$/,
    /(^|\/)tests?\//,
    /^packages\/e2e\//,
    /^packages\/[^/]+-test-support\//,
];

function selection() {
    const newest = JSON.parse(gh("api", `repos/${repository}/branches/main`)).commit.sha;
    if (newest !== revision) {
        return { release: false, reason: `main advanced to ${newest}, whose release ships this commit` };
    }
    if (JSON.parse(gh("api", `repos/${repository}/releases?per_page=1`)).length === 0) {
        return { release: true, reason: "nothing has been released yet" };
    }
    const production = JSON.parse(gh("api", `repos/${repository}/releases/latest`)).target_commitish;
    if (!/^[a-f0-9]{40}$/.test(production)) {
        throw new Error("The latest release does not identify its source revision");
    }
    const shippable = git("diff", "--no-renames", "--name-only", production, revision)
        .split("\n")
        .filter((path) => path !== "" && !unshipped.some((pattern) => pattern.test(path)));
    return shippable.length > 0
        ? { release: true, reason: `${shippable.length} shipped files changed since ${production}` }
        : { release: false, reason: `nothing that ships changed since ${production}` };
}

const { release, reason } = selection();
console.log(`${release ? "Releasing" : "Not releasing"} ${revision}: ${reason}`);
await appendFile(process.env.GITHUB_OUTPUT, `release=${release}\n`);
await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `${release ? "Releasing" : "Not releasing"} ${revision}: ${reason}\n`,
);
