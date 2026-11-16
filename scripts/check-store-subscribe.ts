import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Forbids `store.subscribe(...)` in packages/web/src/view-models.
 *
 * State transitions must be expressed through the stores' explicit
 * transition functions and announced through port callbacks; reacting to a
 * store by subscribing to it reintroduces hidden reactive wiring. React
 * renders may subscribe through a store port passed to
 * `useSyncExternalStore`, which is why only `packages/web/src/views`,
 * `packages/web/src/components`, and tests are exempt.
 */

const SUBSCRIBE_CALL = /\.(subscribe)\s*\(/u;
const SCANNED = "packages/web/src/view-models";
const ALLOWED_SUFFIXES = [".ts", ".tsx"];

const git = spawnSync("git", ["ls-files", SCANNED], { encoding: "utf8" });
if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(1);
}

const violations: string[] = [];
for (const path of git.stdout.split("\n").filter((line) => line.length > 0)) {
    if (!ALLOWED_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
        continue;
    }
    if (!existsSync(path)) {
        continue;
    }
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
        const match = SUBSCRIBE_CALL.exec(line);
        if (match === null) {
            return;
        }
        const isDeclaration =
            /\bsubscribe\s*\(/u.test(line) && /\(\s*\)/u.test(line) === false && /readonly subscribe/u.test(line);
        if (isDeclaration) {
            return;
        }
        violations.push(
            `${path}:${index + 1}:${match.index + 1} store subscriptions are forbidden; announce transitions through port callbacks`,
        );
    });
}

if (violations.length > 0) {
    for (const violation of violations) {
        process.stderr.write(`${violation}\n`);
    }
    process.exit(1);
}
