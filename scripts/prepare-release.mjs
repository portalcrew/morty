import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { releaseVersion } from "./release-artifact.mjs";

const metadata = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
const candidate = process.env.MORTY_RELEASE_CANDIDATE === "true";
const version = candidate ? await releaseVersion() : metadata.version;
if (candidate) {
    const response = await fetch(`https://registry.npmjs.org/@portalcrew%2fmorty/${version}`, {
        signal: AbortSignal.timeout(30_000),
        headers: { "cache-control": "no-cache" },
    });
    await response.body?.cancel();
    if (response.status !== 404) {
        throw new Error(
            "Version exists or registry cannot confirm availability; resume the original immutable archive",
        );
    }
}
metadata.version = version;
await writeFile("packages/cli/package.json", `${JSON.stringify(metadata, null, 4)}\n`);
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(
    `Prepared @portalcrew/morty@${version} from ${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 30000 }).trim()}`,
);
