import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { SentryCli } from "@sentry/cli";

const directory = resolve(process.argv[2] ?? ".release/cloud");
const manifest = JSON.parse(await readFile(resolve(directory, "release.json"), "utf8"));
if (manifest.revision !== process.env.EXPECTED_REVISION) {
    throw new Error("Sentry upload revision does not match the accepted release");
}
// Recovery of an archive built before monitoring was enabled must remain possible.
if (!Object.hasOwn(manifest.files, "sentry.json")) {
    console.log("Archived release predates Sentry; no source maps to upload.");
    process.exit(0);
}
const evidenceFiles = Object.keys(manifest.files).filter(
    (name) => name === "sentry.json" || name.startsWith("sourcemaps/"),
);
if (!evidenceFiles.some((name) => name.endsWith(".js.map"))) {
    throw new Error("Accepted release contains no browser source maps");
}
for (const name of evidenceFiles) {
    const file = resolve(directory, name);
    if (relative(directory, file).startsWith("..") || !(await lstat(file)).isFile()) {
        throw new Error("Invalid source-map archive entry");
    }
    const digest = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    if (digest !== manifest.files[name]) {
        throw new Error("Source-map archive integrity check failed");
    }
}
const target = JSON.parse(await readFile("deployment/sentry.json", "utf8"));
const sentry = JSON.parse(await readFile(resolve(directory, "sentry.json"), "utf8"));
if (
    sentry.organization !== target.organization ||
    sentry.project !== target.project ||
    sentry.environment !== "production" ||
    sentry.release !== `morty@${manifest.revision}`
) {
    throw new Error("Sentry destination or release identity mismatch");
}
if (!process.env.SENTRY_AUTH_TOKEN) {
    throw new Error("SENTRY_AUTH_TOKEN is required before activating a monitored release");
}
function sentryCli(args) {
    execFileSync(SentryCli.getPath(), args, {
        stdio: "inherit",
        timeout: 180_000,
        env: {
            ...process.env,
            SENTRY_ORG: target.organization,
            SENTRY_PROJECT: target.project,
            SENTRY_LOG_LEVEL: "warn",
        },
    });
}
sentryCli(["releases", "new", sentry.release]);
sentryCli([
    "sourcemaps",
    "upload",
    "--release",
    sentry.release,
    "--validate",
    "--wait",
    resolve(directory, "sourcemaps"),
]);
sentryCli(["releases", "finalize", sentry.release]);
console.log(`Verified source maps uploaded for ${sentry.release} to ${target.organization}/${target.project}.`);
