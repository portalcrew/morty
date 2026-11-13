import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
if (
    process.env.GITHUB_REPOSITORY_ID !== "1456063169" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
) {
    throw new Error("Publishing requires the Morty main-branch OIDC job");
}
// npm cannot generate public provenance for a private source repository.
// OIDC still binds publisher authority; release.json records the tested archive and revision.
const provenance = process.env.GITHUB_REPOSITORY_VISIBILITY === "public";
const interrupted = new AbortController();
process.once("SIGINT", () => interrupted.abort());
process.once("SIGTERM", () => interrupted.abort());
const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(8 * 60_000)]);
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(release.name)}/${release.version}`;

async function registryContainsAcceptedRelease() {
    const response = await fetch(registryUrl, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status === 404) {
        await response.body?.cancel();
        return false;
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Registry verification failed with HTTP ${response.status}`);
    }
    const published = await response.json();
    if (
        published?.name !== release.name ||
        published?.version !== release.version ||
        published?.dist?.integrity !== release.integrity
    ) {
        throw new Error("Registry identity or integrity differs from the tested archive");
    }
    return true;
}

// A queued or retried old commit must never move npm latest backwards.
async function registryLatestIsAcceptedRelease() {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(release.name)}/latest`, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Cannot verify the current published release");
    }
    const published = await response.json();
    if (!/^\d+\.\d+\.\d+$/.test(published.version)) {
        throw new Error("Unexpected latest version");
    }
    const currentParts = published.version.split(".").map(Number);
    const nextParts = release.version.split(".").map(Number);
    const difference = currentParts.map((part, index) => part - nextParts[index]).find((part) => part !== 0) ?? 0;
    if (difference > 0) {
        throw new Error("A newer release is already published; refusing a stale run");
    }
    if (difference === 0 && (published.name !== release.name || published.dist?.integrity !== release.integrity)) {
        throw new Error("Latest release integrity differs from the tested archive");
    }
    return difference === 0;
}
await registryLatestIsAcceptedRelease();

if (await registryContainsAcceptedRelease()) {
    console.log("The accepted archive is already published; verifying this retry without republishing.");
} else {
    const result = await promisify(execFile)(
        "npm",
        ["publish", release.archive, "--access", "public", `--provenance=${provenance}`],
        { encoding: "utf8", timeout: 180000, signal, maxBuffer: 4 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    // A successful publish can precede public registry visibility by several minutes.
    while (!(await registryContainsAcceptedRelease())) {
        console.log("npm accepted the publication; waiting for public registry verification.");
        await delay(5000, undefined, { signal });
    }
}
// Exact-version and dist-tag metadata can become visible at different times.
while (!(await registryLatestIsAcceptedRelease())) {
    console.log("Waiting for npm latest to identify the accepted release before the setup instructions change.");
    await delay(5000, undefined, { signal });
}
console.log(`Verified ${release.name}@${release.version} from ${release.revision}`);
