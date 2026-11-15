import { describe, expect, it } from "vitest";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgentPath, RecordingObserver } from "./acp-feature-fixture.ts";

const usage = { cachedReadTokens: 200, inputTokens: 600, outputTokens: 200, thoughtTokens: 50, totalTokens: 1_000 };
const tokenCount = {
    cachedInputTokens: 200,
    inputTokens: 600,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    totalTokens: 1_000,
};
const quota = { model_usage: [{ model: "test-model", token_count: tokenCount }], token_count: tokenCount };
const contextUsage = { used: 50_000, size: 200_000, cost: { amount: 0.125, currency: "USD" } };

function usageAgent(response: Readonly<Record<string, unknown>>, context?: typeof contextUsage): AcpAgentDefinition {
    return createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "controlled-usage",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath],
                    environment: options.environment,
                },
                options,
            ),
        "controlled-usage",
        "Controlled ACP",
        process.execPath,
        {
            MORTY_FAKE_ACP_PROMPT_RESPONSE: JSON.stringify(response),
            ...(context === undefined ? {} : { MORTY_FAKE_ACP_CONTEXT_USAGE: JSON.stringify(context) }),
        },
    );
}

async function run(
    response: Readonly<Record<string, unknown>>,
    observer: RecordingObserver,
    signal: AbortSignal,
    context?: typeof contextUsage,
) {
    const manager = new SessionManager({
        observer,
        store: new MemorySessionStore(),
        adapters: acpAdapters,
        onSessionClosed: () => undefined,
        lastTurn: () => undefined,
        settledTurns: () => [],
        contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
            new UnretainedExternalContentStore().put({
                bytes: content.bytes,
                kind: content.kind,
                mediaType: content.mediaType,
                name: content.name,
                target: sessionTarget,
                signal,
            }),
        ),
        timer: systemTimer,
        maxProcesses: null,
    });
    try {
        return await manager.runPrompt({
            agent: usageAgent(response, context),
            commandId: "usage-command",
            cwd: process.cwd(),
            images: [],
            resources: [],
            target: await manager.createNativeSession({
                agent: usageAgent(response, context),
                cwd: process.cwd(),
                signal,
            }),
            prompt: "Complete this turn",
            signal,
        });
    } finally {
        await manager.close();
    }
}

const recordedContextUsage = (observer: RecordingObserver) =>
    observer.events.flatMap(({ event }) =>
        event.type === "acp" && event.payload.sessionUpdate === "usage_update" ? [event.payload] : [],
    );

describe("controlled ACP usage boundary", () => {
    it.for([
        { name: "absent usage", response: { stopReason: "end_turn", _meta: null, usage: null } },
        {
            name: "unknown metadata",
            response: { stopReason: "end_turn", _meta: { privateData: "must not leave the ACP boundary" } },
        },
        {
            name: "empty quota",
            response: { stopReason: "end_turn", _meta: { quota: { token_count: null, model_usage: [] } } },
        },
        { name: "usage only", response: { stopReason: "end_turn", usage, _meta: null } },
        { name: "quota only", response: { stopReason: "end_turn", usage: null, _meta: { quota } } },
        { name: "cancelled usage", response: { stopReason: "cancelled", usage, _meta: { quota } } },
    ])(
        "Given $name in a final response, When a prompt settles, Then only reported data is preserved",
        async ({ response }, { signal }) => {
            const observer = new RecordingObserver();
            const result = await run(response, observer, signal);
            expect(result.stopReason).toBe(response.stopReason);
            if (response.usage !== undefined && response.usage !== null) {
                expect(result.usage).toMatchObject(response.usage);
            }
            if (response._meta?.quota !== undefined) {
                expect(result._meta?.quota).toBeDefined();
            }
            expect(JSON.stringify(result)).not.toContain("privateData");
        },
    );

    it.for([
        { name: "reasoning tokens", usage, tokenCount },
        {
            name: "cache write tokens",
            usage: { ...usage, cachedWriteTokens: 100, thoughtTokens: null, totalTokens: 1_100 },
            tokenCount: { ...tokenCount, cachedWriteTokens: 100, reasoningOutputTokens: 0, totalTokens: 1_100 },
        },
    ])(
        "Given $name in final usage, When a prompt completes, Then validated usage and quota coexist with recorded context usage",
        async (scenario, { signal }) => {
            const observer = new RecordingObserver();
            const expectedQuota = {
                model_usage: [{ model: "test-model", token_count: scenario.tokenCount }],
                token_count: scenario.tokenCount,
            };
            const result = await run(
                {
                    stopReason: "end_turn",
                    usage: scenario.usage,
                    _meta: { quota: expectedQuota, privateData: "must not leave the ACP boundary" },
                },
                observer,
                signal,
                contextUsage,
            );
            expect(result).toMatchObject({
                stopReason: "end_turn",
                usage: scenario.usage,
                _meta: { quota: expectedQuota },
            });
            expect(JSON.stringify(result)).not.toContain("privateData");
            expect(recordedContextUsage(observer)).toEqual([
                { cost: contextUsage.cost, sessionUpdate: "usage_update", size: 200_000, used: 50_000 },
            ]);
        },
    );

    it("Given snake-case quota metadata, When a prompt completes, Then the response succeeds with normalized bounded usage", async ({
        signal,
    }) => {
        const observer = new RecordingObserver();
        const tokens = { input_tokens: 600, output_tokens: 200 };
        const result = await run(
            {
                stopReason: "end_turn",
                _meta: { quota: { model_usage: [{ model: "test-model", token_count: tokens }], token_count: tokens } },
            },
            observer,
            signal,
        );
        const expectedQuota = {
            model_usage: [
                { model: "test-model", token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 } },
            ],
            token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
        };
        expect(result).toMatchObject({ stopReason: "end_turn", _meta: { quota: expectedQuota } });
    });

    it.for([
        { name: "usage", response: { stopReason: "end_turn", usage: { ...usage, totalTokens: -1 } } },
        {
            name: "quota",
            response: {
                stopReason: "end_turn",
                _meta: { quota: { ...quota, token_count: { ...tokenCount, totalTokens: -1 } } },
            },
        },
    ])(
        "Given malformed final $name, When a prompt completes, Then invalid data is rejected with a sanitized typed failure",
        async ({ response }, { signal }) => {
            const observer = new RecordingObserver();
            await expect(run(response, observer, signal)).rejects.toMatchObject({
                code: "acp_invalid_prompt_response",
                message: "ACP agent returned an invalid prompt response",
            });
            expect(recordedContextUsage(observer)).toEqual([]);
        },
    );
});
