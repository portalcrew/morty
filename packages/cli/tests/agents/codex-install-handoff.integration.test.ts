import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { executableLaunch, runBoundedProcess } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given setup runs in a real Codex exec conversation, When its native session is found and imported, Then the user can continue chatting through the daemon", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "CODEX_INSTALL_HANDOFF_REPLY");
    await using codex = await CodexFixture.create(provider, { configuredModel: provider.model });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const launch = executableLaunch(codex.executable, [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "danger-full-access",
            "Keep this conversation available for the installation handoff",
        ]);
        const seeded = await runBoundedProcess({
            command: launch.command,
            arguments: launch.arguments,
            cwd: peer.workspace,
            environment: { ...process.env, ...codex.environment },
            signal: peer.signal,
            timeoutMilliseconds: 30_000,
            outputLimitBytes: 1_048_576,
        });
        const started = z.object({ type: z.literal("thread.started"), thread_id: z.string().min(1) });
        const sessionId = seeded.stdout
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => started.safeParse(JSON.parse(line)))
            .find((result) => result.success)?.data?.thread_id;
        if (sessionId === undefined) {
            throw new Error(`Native Codex did not report its session ID: ${seeded.stdout}`);
        }

        const identity = {
            harness: "codex",
            directory: ".",
            kind: "native.session.request",
        } as const;
        const nextResult = async (requestId: string) => {
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
                }
                if (kind === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === requestId) {
                        return result;
                    }
                }
            }
        };
        const findRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "find",
                sessionId,
                requestId: findRequestId,
            }),
        );
        const found = await nextResult(findRequestId);
        if (found.action !== "find") {
            throw new Error("Expected the native handoff session");
        }
        expect(found.entry.sessionId).toBe(sessionId);

        const importRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "import",
                sessionId: found.entry.sessionId,
                requestId: importRequestId,
            }),
        );
        const imported = await nextResult(importRequestId);
        expect(imported).toMatchObject({
            action: "import",
            ready: { restored: true },
            target: { harness: "codex", sessionId },
        });
        if (imported.action !== "import") {
            throw new Error("Expected native import");
        }

        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                requestId: commandId,
                commandId,
                requestId: commandId,
                target: imported.target,
                attachments: [],
                prompt: "Continue this conversation after installation",
                disposition: SessionPromptDisposition.Append,
            }),
        );
        let reply = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.completed") &&
                event.payload.commandId === commandId
            ) {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    expect(reply).toContain("CODEX_INSTALL_HANDOFF_REPLY");
                    break;
                }
            }
        }
    });
});
