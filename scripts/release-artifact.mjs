import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Each commit on main's first-parent history has exactly one release version. A
// merge queue commit becomes main unchanged, so it receives the same version.
export async function releaseVersion() {
    const baseline = JSON.parse(await readFile("scripts/release-baseline.json", "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(baseline.version) || !/^[a-f0-9]{40}$/.test(baseline.revision)) {
        throw new Error("Invalid release baseline");
    }
    const history = execFileSync("git", ["rev-list", "--first-parent", "HEAD"], {
        encoding: "utf8",
        timeout: 30000,
    })
        .trim()
        .split("\n");
    const distance = history.indexOf(baseline.revision);
    if (distance < 1) {
        throw new Error("Release must descend from the baseline on main's first-parent history");
    }
    const [major, minor, patch] = baseline.version.split(".").map(Number);
    if (!Number.isSafeInteger(patch + distance)) {
        throw new Error("Release version exceeds the safe range");
    }
    return `${major}.${minor}.${patch + distance}`;
}

export async function verifiedRelease() {
    const manifest = JSON.parse(await readFile(".release/release.json", "utf8"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (
        manifest.name !== "@portalcrew/morty" ||
        !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
        manifest.archive !== `portalcrew-morty-${manifest.version}.tgz` ||
        manifest.revision !== revision
    ) {
        throw new Error("Release identity or source mismatch");
    }
    const archive = resolve(".release", manifest.archive);
    const bytes = await readFile(archive);
    if (
        manifest.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
        manifest.integrity !== `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    ) {
        throw new Error("Release checksum mismatch");
    }
    return { ...manifest, archive };
}
