import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeMessageKind, decodeNativeSessionResult, encodeNativeSessionCommand } from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemonConnection } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given 501 saved Claude sessions, When a user lists every page through the daemon, Then all sessions appear once in pages of at most 500", async ({
    signal,
}) => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_LIST_PROVIDER");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemonConnection(signal, new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const home = agent.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("The Claude fixture requires an isolated configuration directory");
        }
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        const ids = Array.from({ length: 501 }, () => randomUUID());
        await Promise.all(
            ids.map((sessionId, index) =>
                writeFile(
                    join(project, `${sessionId}.jsonl`),
                    `${JSON.stringify({
                        uuid: randomUUID(),
                        parentUuid: null,
                        sessionId,
                        type: "user",
                        isSidechain: false,
                        cwd: peer.workspace,
                        version: "2.1.273",
                        timestamp: "2026-10-24T00:00:00.000Z",
                        message: { role: "user", content: `Saved conversation ${index}` },
                    })}\n`,
                ),
            ),
        );
        const listed: string[] = [];
        let cursor: string | null = null;
        const pageSizes: number[] = [];
        do {
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    harness: "claude",
                    directory: ".",
                    kind: "native.session.request",
                    action: "list",
                    cursor,
                    requestId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind !== "native.session.result") {
                    continue;
                }
                const result = decodeNativeSessionResult(message);
                if (result.requestId !== requestId) {
                    continue;
                }
                if (result.action !== "list") {
                    throw new Error("Expected a native session list");
                }
                listed.push(...result.entries.map((entry) => entry.sessionId));
                pageSizes.push(result.entries.length);
                cursor = result.nextCursor;
                break;
            }
            expect(pageSizes.length).toBeLessThanOrEqual(2);
        } while (cursor !== null);
        expect(pageSizes).toEqual([500, 1]);
        expect(listed.toSorted()).toEqual(ids.toSorted());
    });
});
