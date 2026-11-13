import { appendFile } from "node:fs/promises";

// Markdown cannot change tests or the release archive's behavior, so a change that touches only Markdown skips the test
// jobs. Every doubt runs everything: no revision range, an empty diff, or a range GitHub cannot list completely.
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "";
const markdown = /\.(md|markdown|mdx)$/i;
// GitHub lists at most this many files of one comparison.
const listingLimit = 3000;
const pageSize = 100;

async function changedPaths() {
    const paths = [];
    for (let page = 1; ; page += 1) {
        const response = await fetch(
            `https://api.github.com/repos/${repository}/compare/${base}...${head}?per_page=${pageSize}&page=${page}`,
            {
                headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(30000),
            },
        );
        if (!response.ok) {
            throw new Error(`Comparing ${base}...${head} failed with status ${response.status}`);
        }
        const { files } = await response.json();
        // A rename lists both paths, as a diff without rename detection does.
        paths.push(...files.flatMap((file) => [file.filename, file.previous_filename ?? file.filename]));
        if (files.length < pageSize || paths.length >= listingLimit) {
            return paths;
        }
    }
}

async function classify() {
    if (base === "" || head === "") {
        return { markdownOnly: false, reason: "no revision range to compare" };
    }
    try {
        const paths = await changedPaths();
        if (paths.length === 0 || paths.length >= listingLimit) {
            return { markdownOnly: false, reason: `${paths.length} listed paths` };
        }
        const other = paths.filter((path) => !markdown.test(path));
        return other.length === 0
            ? { markdownOnly: true, reason: "only Markdown changed" }
            : { markdownOnly: false, reason: `${other.length} files other than Markdown changed` };
    } catch (error) {
        console.warn(`Running everything: ${error instanceof Error ? error.message : String(error)}`);
        return { markdownOnly: false, reason: "the changed files could not be listed" };
    }
}

const { markdownOnly, reason } = await classify();
console.log(`markdown-only=${markdownOnly}: ${reason}`);
await appendFile(process.env.GITHUB_OUTPUT, `markdown-only=${markdownOnly}\n`);
