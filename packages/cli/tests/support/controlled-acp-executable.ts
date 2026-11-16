import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeAgentPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));

/**
 * Put the controlled ACP peer on PATH as `controlled-acp` and return that
 * directory. The managed daemon discovers Agents through the production catalog,
 * so a lifecycle report through a real managed daemon needs a real executable.
 * With `loadSession`, the peer replays saved history, where `pause-load` can hold it.
 */
export async function writeControlledAcpExecutable(
    directory: string,
    { loadSession = false }: { readonly loadSession?: boolean } = {},
): Promise<string> {
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",${loadSession ? "" : '\n    "--no-load-session",'}
    "--http-mcp",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    return executableDirectory;
}
