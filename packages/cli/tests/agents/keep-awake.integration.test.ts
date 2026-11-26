import { randomUUID } from "node:crypto";
import { encodeSessionPromptCommand, SessionPromptDisposition } from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import type { LocalAgentSpecification } from "../../src/engine/agent/specification/agent-specification.ts";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { nextPromptSettlement, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { RecordingSleepPrevention } from "../support/recording-sleep-prevention.ts";

/** The model holds its first reply until released, so the Agent is still working when the test looks. */
const heldModel = () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    return {
        entered: entered.promise,
        release: reply.resolve,
        beforeFirstText: async () => {
            entered.resolve();
            await reply.promise;
        },
    };
};

const expectAwakeWhileWorking = async (
    signal: AbortSignal,
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    model: ReturnType<typeof heldModel>,
): Promise<void> => {
    const computer = new RecordingSleepPrevention();
    await withRealDaemon(
        signal,
        specification,
        environment,
        async (peer) => {
            expect(computer.awake).toBe(false);
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Summarize the workspace",
                    target: peer.target,
                }),
            );
            await model.entered;
            expect(computer.awake).toBe(true);

            model.release();
            expect(await nextPromptSettlement(peer, commandId)).toMatchObject({ kind: "prompt.completed" });
            await computer.asleep();
            expect(computer.holds).toBe(1);
        },
        "embedded",
        undefined,
        systemTimer,
        undefined,
        computer,
    );
};

test("Given real Codex works on a prompt through Morty, When its reply completes, Then the computer stays awake while Codex works and may sleep afterwards", async ({
    signal,
}) => {
    const model = heldModel();
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "Codex reply", {
        beforeFirstText: model.beforeFirstText,
    });
    await using codex = await CodexFixture.create(provider);
    await expectAwakeWhileWorking(signal, new CodexAgentSpecification(), codex.environment, model);
});

test("Given real Claude Code works on a prompt through Morty, When its reply completes, Then the computer stays awake while Claude Code works and may sleep afterwards", async ({
    signal,
}) => {
    const model = heldModel();
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "Claude reply", {
        beforeFirstText: model.beforeFirstText,
    });
    await using claude = await ClaudeFixture.create(provider);
    await expectAwakeWhileWorking(signal, new ClaudeCodeAgentSpecification(), claude.environment, model);
});

test("Given real Pi works on a prompt through Morty, When its reply completes, Then the computer stays awake while Pi works and may sleep afterwards", async ({
    signal,
}) => {
    const model = heldModel();
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "Pi reply", {
        beforeFirstText: model.beforeFirstText,
    });
    await using pi = await PiFixture.create(provider);
    await expectAwakeWhileWorking(signal, new PiAgentSpecification(), pi.environment, model);
});
