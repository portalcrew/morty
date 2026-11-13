import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
    entryPoints: ["packages/web/src/services/remote-agent.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
    minify: true,
    legalComments: "none",
});
const bundle = result.outputFiles[0]?.text;
if (bundle === undefined || bundle.includes("```")) {
    throw new Error("Invalid remote Agent bundle");
}
await mkdir("packages/worker/src/worker/components/instruction-documents/generated", { recursive: true });
const output = "packages/worker/src/worker/components/instruction-documents/generated/agent-client.ts";
const temporary = `${output}.${randomUUID()}.tmp`;
try {
    await writeFile(temporary, `export default ${JSON.stringify(bundle)};\n`);
    await rename(temporary, output);
} finally {
    await rm(temporary, { force: true });
}
