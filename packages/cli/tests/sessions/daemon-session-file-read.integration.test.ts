import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    decodeContentChunkFrame,
    decodeFileBeginEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeSessionLiveEvent,
    encodeFileReadCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class PromptMediaAgent extends ControlledAcpSpecification {
    readonly agentExecutable = "node";
    readonly harness = "controlled-acp";
    readonly label = "Controlled prompt media";
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor() {
        super("MORTY_TEST_PROMPT_MEDIA_PATH", [fakeAgentPath]);
    }
}

test("Given a persisted native conversation, When a client prompts after restart without preparing first, Then its generated image is readable under the same native pair", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
    const directory = await mkdtemp(join(tmpdir(), "morty-prompt-media-"));
    try {
        await withRealDaemon(
            new PromptMediaAgent(),
            {
                MORTY_TEST_PROMPT_MEDIA_PATH: process.execPath,
                MORTY_FAKE_ACP_STATE_DIRECTORY: directory,
            },
            async (peer) => {
                const prompt = async (text: string): Promise<string> => {
                    const commandId = crypto.randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            target: peer.target,
                            commandId,
                            requestId: commandId,
                            disposition: SessionPromptDisposition.Append,
                            attachments: [],
                            prompt: text,
                        }),
                    );
                    let imageKey = "";
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type === "acp" && event.payload.sessionUpdate === "tool_call_update") {
                            for (const item of event.payload.content ?? []) {
                                if (item.type === "content" && item.content.type === "external_image") {
                                    imageKey = item.content.imageKey;
                                }
                            }
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.failed" &&
                            event.payload.commandId === commandId
                        ) {
                            throw new Error(JSON.stringify(event.payload));
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId
                        ) {
                            return imageKey;
                        }
                    }
                };
                await prompt("Remember this conversation");
                await peer.restart();
                const imageKey = await prompt("generate inline image");
                expect(imageKey).toMatch(/^[a-f0-9]{64}$/u);
                const image = await readSessionFile(peer, peer.target, `morty-content:image:${imageKey}`);
                expect(image.kind).toBe("streamed");
                expect(image.bytes).toEqual(
                    Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        "base64",
                    ),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
});

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

interface FileReadResult {
    readonly bytes: Buffer;
    readonly kind: "failed" | "streamed";
    readonly mediaType: string;
    readonly message: string;
}

/** Reads one file through the daemon's public file.read protocol boundary. */
async function readSessionFile(
    peer: Parameters<Parameters<typeof withRealDaemon>[2]>[0],
    sessionTarget: Parameters<Parameters<typeof withRealDaemon>[2]>[0]["target"],
    path: string,
): Promise<FileReadResult> {
    const requestId = `read-${path.replaceAll(/[^a-zA-Z0-9]/gu, "-")}`;
    peer.send(
        encodeFileReadCommand({
            kind: "file.read",
            maxBytes: 65_536,
            path,
            requestId,
            target: sessionTarget,
        }),
    );
    const chunks: Buffer[] = [];
    for (;;) {
        const message = await peer.nextFrame();
        if (typeof message !== "string") {
            chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
            continue;
        }
        const kind = decodeMessageKind(message);
        if (kind === "file.failed") {
            return {
                bytes: Buffer.alloc(0),
                kind: "failed",
                mediaType: "",
                message: decodeFileFailedEvent(message).message,
            };
        }
        if (kind === "file.begin") {
            const begin = decodeFileBeginEvent(message);
            expect(begin.target).toEqual(sessionTarget);
            expect(begin.requestId).toBe(requestId);
        } else if (kind === "file.end") {
            return { bytes: Buffer.concat(chunks), kind: "streamed", mediaType: "", message: "" };
        }
    }
}

test("Given a session with a working directory, When a client reads a root-relative or bare-relative file reference, Then the daemon resolves it against the session directory before the computer root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-session-file-read-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "assets", "каталог résumé"), { recursive: true });
    await writeFile(join(workspace, "index.html"), "<!doctype html>\n<title>Todo</title>\n");
    await writeFile(join(workspace, "assets", "каталог résumé", "app.js"), "export const todo = true;\n");
    // Explicit file URL targets outside the workspace, each with a decoy at the
    // path a working-directory-first interpretation of the URL would select.
    const outsideTarget = join(directory, "report.html");
    await writeFile(outsideTarget, "<!doctype html>\n<title>Outside</title>\n");
    const absentTarget = join(directory, "absent.html");
    const decoyDirectory = join(workspace, directory);
    await mkdir(decoyDirectory, { recursive: true });
    await writeFile(join(decoyDirectory, "report.html"), "<!doctype html>\n<title>Workspace decoy</title>\n");
    await writeFile(join(decoyDirectory, "absent.html"), "<!doctype html>\n<title>Decoy</title>\n");
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            { PATH: executableDirectory },
            async (peer) => {
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId: "prepare-file-read-session",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }

                // Root-relative agent references resolve against the session
                // working directory, not the computer root.
                const rootRelative = await readSessionFile(peer, peer.target, "/index.html");
                expect(rootRelative.kind).toBe("streamed");
                expect(rootRelative.bytes.toString("utf8")).toContain("<title>Todo</title>");

                // Absolute computer paths keep working.
                const absolute = await readSessionFile(peer, peer.target, join(workspace, "index.html"));
                expect(absolute.kind).toBe("streamed");
                expect(absolute.bytes.toString("utf8")).toContain("<title>Todo</title>");

                // Bare-relative references and non-ASCII or nested targets keep resolving.
                const bareRelative = await readSessionFile(peer, peer.target, "index.html");
                expect(bareRelative.kind).toBe("streamed");
                expect(bareRelative.bytes.toString("utf8")).toContain("<title>Todo</title>");
                const nested = await readSessionFile(peer, peer.target, "/assets/каталог résumé/app.js");
                expect(nested.kind).toBe("streamed");
                expect(nested.bytes.toString("utf8")).toContain("export const todo = true;");

                // Missing references fail without inventing a target.
                const missing = await readSessionFile(peer, peer.target, "/missing-file.html");
                expect(missing.kind).toBe("failed");

                // Explicit file URLs always mean their computer-absolute target,
                // even when a working-directory-first interpretation would
                // select a different existing file.
                const urlRead = await readSessionFile(peer, peer.target, pathToFileURL(outsideTarget).href);
                expect(urlRead.kind).toBe("streamed");
                expect(urlRead.bytes.toString("utf8")).toContain("<title>Outside</title>");
                expect(urlRead.bytes.toString("utf8")).not.toContain("Workspace decoy");

                // An explicit file URL to a missing target fails; the decoy at
                // the working-directory interpretation is not a substitute.
                const absentUrlRead = await readSessionFile(peer, peer.target, pathToFileURL(absentTarget).href);
                expect(absentUrlRead.kind).toBe("failed");
            },
            "embedded",
            workspace,
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("Given a session with a file, When a file read arrives without the Computer's encryption access, Then the daemon streams nothing for it and still serves the read that has it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-unsealed-file-read-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    const workspace = join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "index.html"), "<!doctype html>\n<title>Todo</title>\n");
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            { PATH: executableDirectory },
            async (peer) => {
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId: "prepare-unsealed-file-read-session",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }
                // The daemon handles messages in arrival order: an answer to this one would reach the next read first.
                peer.sendUnsealed(
                    JSON.stringify({
                        kind: "file.read",
                        maxBytes: 65_536,
                        path: join(workspace, "index.html"),
                        requestId: "unsealed-file-read",
                        target: peer.target,
                    }),
                );
                const sealed = await readSessionFile(peer, peer.target, "/index.html");
                expect(sealed.kind).toBe("streamed");
                expect(sealed.bytes.toString("utf8")).toContain("<title>Todo</title>");
            },
            "embedded",
            workspace,
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
