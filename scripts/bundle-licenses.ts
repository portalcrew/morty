import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as v from "valibot";
import type { Plugin } from "vite";

const licenseSchema = v.array(
    v.object({
        name: v.string(),
        version: v.string(),
        identifier: v.optional(v.pipe(v.string(), v.minLength(1))),
        text: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
);

/** Vite identifies the bundled dependencies; refuse to distribute missing license text. */
export function bundleLicenses(fileName: string): Plugin {
    return {
        name: "morty-bundle-licenses",
        generateBundle: {
            order: "post",
            async handler(_options, bundle) {
                const metadata = bundle["bundle-licenses.json"];
                if (metadata?.type !== "asset") {
                    throw new Error("The bundled dependency license inventory is missing");
                }
                const raw: unknown = JSON.parse(
                    typeof metadata.source === "string" ? metadata.source : new TextDecoder().decode(metadata.source),
                );
                const licenses = v.parse(licenseSchema, raw);
                const dependencyTexts: string[] = [];
                for (const entry of licenses) {
                    // Exact npm releases whose license is missing from Vite's supported filenames.
                    const retained = [
                        // https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE
                        {
                            name: "drizzle-orm",
                            version: "0.45.4",
                            identifier: "Apache-2.0",
                            file: "drizzle-orm-0.45.4-LICENSE",
                        },
                        // Unmodified License section from fastdom@1.0.12's npm README.md.
                        { name: "fastdom", version: "1.0.12", identifier: "MIT", file: "fastdom-1.0.12-LICENSE" },
                        // The npm release declares MIT; its author supplied the missing license text upstream.
                        // https://github.com/theKashey/react-remove-scroll-bar/blob/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE
                        {
                            name: "react-remove-scroll-bar",
                            version: "2.3.8",
                            identifier: "MIT",
                            file: "react-remove-scroll-bar-2.3.8-LICENSE",
                        },
                        // https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license
                        {
                            name: "rehype-katex",
                            version: "7.0.1",
                            identifier: "MIT",
                            file: "rehype-katex-7.0.1-LICENSE",
                        },
                        // https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license
                        { name: "remark-math", version: "6.0.0", identifier: "MIT", file: "remark-math-6.0.0-LICENSE" },
                    ].find(
                        (candidate) =>
                            candidate.name === entry.name &&
                            candidate.version === entry.version &&
                            candidate.identifier === entry.identifier,
                    );
                    const text =
                        entry.text ??
                        (retained === undefined
                            ? undefined
                            : await readFile(new URL(`./licenses/${retained.file}`, import.meta.url), "utf8"));
                    if (text === undefined || text.trim().length === 0) {
                        throw new Error(
                            `Missing bundled license text: ${entry.name}@${entry.version}; incomplete inventory: ${licenses
                                .filter((candidate) => candidate.text === undefined)
                                .map((candidate) => `${candidate.name}@${candidate.version}`)
                                .join(", ")}`,
                        );
                    }
                    dependencyTexts.push(
                        `${entry.name}@${entry.version} (${entry.identifier ?? "see license text"})\n\n${text}`,
                    );
                }
                const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
                const notice = await readFile(new URL("../NOTICE", import.meta.url), "utf8");
                const packageSchema = v.object({ name: v.string(), version: v.string() });
                const bundledPackages = new Set(licenses.map((entry) => `${entry.name}@${entry.version}`));
                const inspectedDirectories = new Set<string>();
                const dependencyNotices: string[] = [];
                // Vite collects LICENSE files; preserve separate upstream NOTICE/COPYRIGHT files too.
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type !== "chunk") {
                        continue;
                    }
                    for (const moduleId of chunk.moduleIds) {
                        if (!isAbsolute(moduleId) || !moduleId.replaceAll("\\", "/").includes("/node_modules/")) {
                            continue;
                        }
                        let directory = dirname(moduleId);
                        while (!inspectedDirectories.has(directory)) {
                            inspectedDirectories.add(directory);
                            const manifest = join(directory, "package.json");
                            if (existsSync(manifest)) {
                                const rawPackage: unknown = JSON.parse(await readFile(manifest, "utf8"));
                                const parsed = v.safeParse(packageSchema, rawPackage);
                                if (parsed.success) {
                                    const key = `${parsed.output.name}@${parsed.output.version}`;
                                    if (bundledPackages.has(key)) {
                                        for (const file of await readdir(directory, { withFileTypes: true })) {
                                            if (
                                                file.isFile() &&
                                                /^(?:notice|copyright|copying)(?:$|[._-])/iu.test(file.name)
                                            ) {
                                                dependencyNotices.push(
                                                    `${key}: ${file.name}\n\n${await readFile(join(directory, file.name), "utf8")}`,
                                                );
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                            const parent = dirname(directory);
                            if (parent === directory) {
                                break;
                            }
                            directory = parent;
                        }
                    }
                }
                const text = [license, notice, ...dependencyTexts, ...dependencyNotices.sort()].join(
                    "\n--------------------------------------------------------------------------------\n\n",
                );
                delete bundle["bundle-licenses.json"];
                this.emitFile({ type: "asset", fileName, source: text });
            },
        },
    };
}
