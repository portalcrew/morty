import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";

class HistoryAgentSpecification extends ControlledAcpSpecification {
    readonly harness = "claude";
    readonly label = "Claude Code";
    readonly agentExecutable = "controlled-acp";
    override readonly minimumSupportedAgentVersion = "1.0.0";
    constructor() {
        super("MORTY_TEST_CONTROLLED_ACP_PATH", []);
    }
}

import { withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";

// Persisted native history is owned by the controlled ACP peer, not by Morty.
test.for([
    { name: "6000 messages", count: 6000, images: false },
    { name: "32 embedded images", count: 32, images: true },
])(
    "Given native history with $name, When its preview is loaded through the daemon, Then replay drains without losing messages or overflowing the output queue",
    async (scenario, { signal }) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-history-backpressure-"));
        const executable = join(directory, "controlled-acp");
        const stateDirectory = join(directory, "state");
        const sessionId = "large-native-history";
        const count = scenario.count;
        const image = Buffer.concat([
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
            Buffer.alloc(750_000),
        ]).toString("base64");
        await mkdir(stateDirectory);
        await writeFile(
            executable,
            `#!${process.execPath}
if (process.argv.includes("--version")) {
    process.stdout.write("1.0.0\\n");
} else {
    process.argv.push("--agent-name", "Controlled ACP", "--agent-version", "1.0.0", "--http-mcp", "--no-delete-session", "--no-fork-session", "--no-embedded-context");
    await import(${JSON.stringify(new URL("./fixtures/acp-peer.ts", import.meta.url).toString())});
}
`,
            { mode: 0o700 },
        );
        await writeFile(
            join(stateDirectory, `${sessionId}.json`),
            JSON.stringify({
                fastMode: false,
                history: Array.from({ length: count }, (_, index) => ({
                    messageId: `history-${index}`,
                    role: "user",
                    text: `History message ${index}`,
                    images: scenario.images ? [{ data: image, mimeType: "image/png" }] : [],
                })),
                mode: "code",
                model: "test-small",
                reasoningEffort: "medium",
                turnCount: 0,
            }),
        );
        try {
            await withRealDaemon(
                signal,
                new HistoryAgentSpecification(),
                {
                    MORTY_FAKE_ACP_STATE_DIRECTORY: stateDirectory,
                    MORTY_TEST_CONTROLLED_ACP_PATH: executable,
                },
                async (peer) => {
                    peer.send(
                        encodeSessionPreviewHistoryPageLoad({
                            cursor: null,
                            directory: ".",
                            eventLimit: 10000,
                            kind: "session.preview-history.page.load",
                            requestId: "large-history-preview",
                            target: { harness: "claude", sessionId },
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind !== "session.preview-history.page.loaded") {
                            continue;
                        }
                        const page = decodeSessionPreviewHistoryPageLoaded(message);
                        const text = page.events.events.events.flatMap((event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text"
                                ? [event.payload.content.text]
                                : [],
                        );
                        if (scenario.images) {
                            expect(
                                page.events.events.events.filter(
                                    (event) =>
                                        event.type === "acp" &&
                                        event.payload.sessionUpdate === "user_message_chunk" &&
                                        event.payload.content.type === "external_image",
                                ),
                            ).toHaveLength(count);
                        }
                        expect(text).toEqual(Array.from({ length: count }, (_, index) => `History message ${index}`));
                        break;
                    }
                },
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    },
);
