import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
const cloud = JSON.parse(await readFile(".release/cloud/release.json", "utf8"));
if (
    cloud.revision !== release.revision ||
    cloud.cliVersion !== release.version ||
    cloud.cliRelease?.integrity !== release.integrity
) {
    throw new Error("Cloud and CLI release identities differ");
}
const evidenceRoot = ".release/evidence";
const evidenceDirectories = (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^deployment-evidence-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)))
    .map((directory) => join(evidenceRoot, directory));
let evidence;
// A single artifact is extracted directly; multiple artifacts retain their names.
for (const directory of [evidenceRoot, ...evidenceDirectories]) {
    const files = await readdir(directory);
    if (files.includes("deployment-evidence.json")) {
        evidence = JSON.parse(await readFile(join(directory, "deployment-evidence.json"), "utf8"));
        break;
    }
}
if (
    !evidence?.passed ||
    evidence.revision !== release.revision ||
    evidence.cliVersion !== release.version ||
    evidence.cliIntegrity !== release.integrity
) {
    throw new Error("No successful deployment evidence for this exact release");
}
const instructionUrl = new URL("/setup.md", cloud.target.morty_origin);
const instructionCheck = evidence.checks?.find((check) => check.url === instructionUrl.href && check.status === 200);
const currentInstructions = await fetch(instructionUrl, {
    signal: AbortSignal.timeout(40_000),
    headers: { "cache-control": "no-cache" },
});
if (
    !instructionCheck ||
    !currentInstructions.ok ||
    createHash("sha256")
        .update(Buffer.from(await currentInstructions.arrayBuffer()))
        .digest("hex") !== instructionCheck.sha256
) {
    throw new Error("Production no longer serves the verified CLI setup instructions");
}
const currentNpm = await fetch("https://registry.npmjs.org/@morty-build%2fcli/latest", {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
});
if (!currentNpm.ok) {
    await currentNpm.body?.cancel();
    throw new Error("Cannot verify the current npm release");
}
const published = await currentNpm.json();
if (published.version !== release.version || published.dist?.integrity !== release.integrity) {
    throw new Error("Refusing to finalize a superseded or mismatched release");
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const repository = process.env.GITHUB_REPOSITORY;
if (process.env.GITHUB_REPOSITORY_ID !== "1456063169" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Release finalization requires the protected main workflow");
}
if (!/^\d+$/.test(process.env.ACCEPTANCE_RUN_ID ?? "")) {
    throw new Error("Release finalization requires the accepting workflow run");
}
const tag = `v${release.version}`;
const refs = JSON.parse(gh("api", `repos/${repository}/git/matching-refs/tags/${tag}`));
const existingTag = refs.find((ref) => ref.ref === `refs/tags/${tag}`);
if (existingTag && (existingTag.object.type !== "commit" || existingTag.object.sha !== release.revision)) {
    throw new Error("The release tag already identifies different source");
}
// Filter each page in gh so release history cannot overflow the child-process buffer.
// Listing still finds drafts and propagates API failures instead of treating them as absence.
const matchingRelease = gh(
    "api",
    "--paginate",
    "--jq",
    `.[] | select(.tag_name == ${JSON.stringify(tag)})`,
    `repos/${repository}/releases?per_page=100`,
).trim();
const existing = matchingRelease ? JSON.parse(matchingRelease) : undefined;
if (existing && !existingTag) {
    if (existing.target_commitish !== release.revision) {
        throw new Error("Draft release source mismatch");
    }
}
await mkdir(".release/assets", { recursive: true });
await copyFile(release.archive, join(".release/assets", basename(release.archive)));
await copyFile(".release/release.json", ".release/assets/cli-release.json");
await copyFile(".release/cloud/release.json", ".release/assets/cloud-release.json");
await writeFile(".release/assets/deployment-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
// Canonical metadata makes retries produce the same archived cloud bytes.
execFileSync(
    "tar",
    [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=gnu",
        "-czf",
        ".release/assets/cloud.tar.gz",
        "-C",
        ".release/cloud",
        ".",
    ],
    { timeout: 120000 },
);
const verifyPublishedAssets = async (publishedRelease) => {
    if (!publishedRelease.immutable || publishedRelease.draft) {
        throw new Error("The final release must have repository-enforced immutability");
    }
    const expectedNames = [
        basename(release.archive),
        "cli-release.json",
        "cloud-release.json",
        "cloud.tar.gz",
        "deployment-evidence.json",
    ];
    if (
        publishedRelease.assets.length !== expectedNames.length ||
        publishedRelease.assets.some((asset) => !expectedNames.includes(asset.name) || asset.state !== "uploaded")
    ) {
        throw new Error("Final release asset inventory differs from the accepted release");
    }
    for (const name of expectedNames.filter((name) => name !== "deployment-evidence.json")) {
        const digest = `sha256:${createHash("sha256")
            .update(await readFile(join(".release/assets", name)))
            .digest("hex")}`;
        const asset = publishedRelease.assets.find((candidate) => candidate.name === name);
        if (asset?.digest !== digest || asset.state !== "uploaded") {
            throw new Error("Final release assets do not match the accepted artifacts");
        }
    }
};
if (existing && !existing.draft) {
    await verifyPublishedAssets(existing);
    console.log(`Release ${tag} is already finalized at ${release.revision}`);
    process.exit(0);
}
// Release notes name what changed: GitHub lists the pull requests merged since the previous release.
const { body: changes } = JSON.parse(
    gh(
        "api",
        "--method",
        "POST",
        `repos/${repository}/releases/generate-notes`,
        "--raw-field",
        `tag_name=${tag}`,
        "--raw-field",
        `target_commitish=${release.revision}`,
    ),
);
await writeFile(
    ".release/notes.txt",
    `${changes}\n\nSource: ${release.revision}\n\nCLI: @morty-build/cli@${release.version}\nSHA-256: ${release.sha256}\n\nPublished with npm trusted publishing, verified against the accepted archive, and deployed to production before finalizing this release.\n\nAcceptance: https://github.com/${repository}/actions/runs/${process.env.ACCEPTANCE_RUN_ID}\nDeployment: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n`,
);
if (!existing) {
    gh(
        "release",
        "create",
        tag,
        "--draft",
        "--target",
        release.revision,
        "--title",
        tag,
        "--notes-file",
        ".release/notes.txt",
    );
}
if (
    existing?.assets.some(
        (asset) =>
            ![
                basename(release.archive),
                "cli-release.json",
                "cloud-release.json",
                "cloud.tar.gz",
                "deployment-evidence.json",
            ].includes(asset.name),
    )
) {
    throw new Error("Draft contains unexpected assets; inspect it before resuming");
}
// Only this workflow's still-private draft may receive resumed asset uploads.
const assets = (await readdir(".release/assets")).map((name) => join(".release/assets", name));
gh("release", "upload", tag, ...assets, "--clobber");
gh("release", "edit", tag, "--draft=false", "--latest");
await verifyPublishedAssets(JSON.parse(gh("api", `repos/${repository}/releases/tags/${tag}`)));
console.log(`Finalized ${tag} from ${release.revision}`);
