import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(".release");
await mkdir(directory, { recursive: true });
const metadata = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
const archive = `portalcrew-morty-${metadata.version}.tgz`;
execFileSync("npm", ["pack", "./packages/cli", "--ignore-scripts", "--pack-destination", directory], {
    stdio: "inherit",
    timeout: 120000,
});
const bytes = await readFile(resolve(directory, archive));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await writeFile(
    resolve(directory, "release.json"),
    `${JSON.stringify({ name: metadata.name, version: metadata.version, archive, revision, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha256: createHash("sha256").update(bytes).digest("hex") }, null, 2)}\n`,
);
