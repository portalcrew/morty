import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a deeply nested multibyte workspace, When real Codex runs a tool through the daemon, Then it writes in the selected directory and its native history reopens", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-long-codex-"));
    try {
        // macOS has a lower filesystem path limit; Linux exercises deeper paths.
        const workspace = join(
            root,
            ...Array.from({ length: process.platform === "linux" ? 8 : 3 }, () => "\u00e9".repeat(110)),
        );
        await mkdir(workspace, { recursive: true });
        const canonical = await realpath(workspace);
        const directory = canonical;
        expect(directory).toBe(canonical);
        const prompt = "Write the actual working directory to workspace-result.txt, then report completion.";
        const command = `node -e "require('node:fs').writeFileSync('workspace-result.txt', process.cwd())"`;
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "LONG_WORKSPACE_DONE", {
            toolPrompt: prompt,
            toolSequence: [
                {
                    name: "exec",
                    input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)} }); text(result.output);`,
                },
            ],
        });
        await using agent = await CodexFixture.create(provider);
        await withRealDaemon(
            new CodexAgentSpecification(),
            agent.environment,
            async (peer) => {
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt,
                        target: peer.target,
                    }),
                );
                let response = "";
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        response += event.payload.content.text;
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                expect(response).toContain("LONG_WORKSPACE_DONE");
                expect(await readFile(join(workspace, "workspace-result.txt"), "utf8")).toBe(canonical);
                const requestId = randomUUID();
                peer.send(
                    encodeSessionHistoryPageLoad({
                        kind: "session.live-history.v2.page.load",
                        requestId,
                        target: peer.target,
                        cursor: null,
                        eventLimit: 100,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                        continue;
                    }
                    const history = decodeSessionHistoryPageLoaded(message);
                    if (history.requestId !== requestId) {
                        continue;
                    }
                    expect(JSON.stringify(history)).toContain("LONG_WORKSPACE_DONE");
                    expect(JSON.stringify(history)).toContain("workspace-result.txt");
                    break;
                }
            },
            "embedded",
            workspace,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
