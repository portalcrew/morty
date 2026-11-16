import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const HAN_CHARACTER = /\p{Script=Han}/u;
const NULL_BYTE = 0;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

interface TextLocation {
    readonly character: string;
    readonly line: number;
    readonly column: number;
}

interface ChineseTextViolation extends TextLocation {
    readonly path: string;
    readonly source: "content" | "path" | "symlink-target";
}

function findHanCharacter(value: string): TextLocation | null {
    const match = HAN_CHARACTER.exec(value);
    if (match === null) {
        return null;
    }

    const prefix = value.slice(0, match.index);
    const lineStart = prefix.lastIndexOf("\n") + 1;

    return {
        character: match[0],
        line: prefix.split("\n").length,
        column: [...prefix.slice(lineStart)].length + 1,
    };
}

function violation(path: string, source: ChineseTextViolation["source"], location: TextLocation): ChineseTextViolation {
    return { path, source, ...location };
}

function findChineseTextViolations(root: string, paths: readonly string[]): readonly ChineseTextViolation[] {
    const violations: ChineseTextViolation[] = [];

    for (const path of paths) {
        const pathMatch = findHanCharacter(path);
        if (pathMatch !== null) {
            violations.push(violation(path, "path", pathMatch));
        }

        const absolutePath = join(root, path);
        const file = lstatSync(absolutePath, { throwIfNoEntry: false });
        if (file === undefined) {
            continue;
        }
        if (file.isSymbolicLink()) {
            const targetMatch = findHanCharacter(readlinkSync(absolutePath, "utf8"));
            if (targetMatch !== null) {
                violations.push(violation(path, "symlink-target", targetMatch));
            }
            continue;
        }
        if (!file.isFile()) {
            continue;
        }

        if (path === "README.md" || path === "README.zh-CN.md") {
            continue;
        }

        const content = readFileSync(absolutePath);
        if (content.includes(NULL_BYTE)) {
            continue;
        }

        const contentMatch = findHanCharacter(content.toString("utf8"));
        if (contentMatch !== null) {
            violations.push(violation(path, "content", contentMatch));
        }
    }

    return violations;
}

function git(root: string, args: readonly string[]): string {
    const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
    });

    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }

    return result.stdout;
}

function repositoryRoot(): string {
    return git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
}

function repositoryPaths(root: string): readonly string[] {
    return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter((path) => path.length > 0)
        .sort();
}

function formatViolation(item: ChineseTextViolation): string {
    return `${item.path}:${item.line}:${item.column}: prohibited Han character ${JSON.stringify(item.character)} in ${item.source}`;
}

function run(): number {
    const root = repositoryRoot();
    const paths = repositoryPaths(root);
    const violations = findChineseTextViolations(root, paths);

    if (violations.length > 0) {
        for (const item of violations) {
            console.error(formatViolation(item));
        }
        return 1;
    }

    console.log(`No Han characters found in ${paths.length} project files.`);
    return 0;
}

process.exitCode = run();
