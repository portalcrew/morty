import { test as base, expect, type Page } from "@playwright/test";
import { E2EHarness } from "./harness.ts";
import { LocalStack } from "./local-stack.ts";
import { createTestRuntime } from "./test-runtime.ts";

export { expect } from "@playwright/test";

/**
 * Waits for the opened conversation to finish loading its messages. Its composer is already enabled while they load,
 * so an enabled composer alone does not mean the conversation a scenario starts from is open.
 */
export async function conversationLoaded(page: Page): Promise<void> {
    await expect(
        page.getByRole("log", { name: "Messages" }).getByRole("status", { name: "Loading messages" }),
    ).toBeHidden();
}

function runtimeTest() {
    return base.extend<{
        readonly stack: LocalStack;
        readonly runtime: Awaited<ReturnType<typeof createTestRuntime>>;
        readonly runtimeComputerName: string;
        readonly runtimeAgent: { readonly harness: string; readonly name: string };
    }>({
        runtimeComputerName: ["Browser test Runtime", { option: true }],
        runtimeAgent: [{ harness: "claude", name: "Claude Code" }, { option: true }],
        stack: async ({ browserName }, use, testInfo) => {
            const harness = await E2EHarness.create(`chat-e2e-${browserName}`);
            let failure: unknown;
            try {
                const stack = await LocalStack.create(harness);
                await stack.start();
                await use(stack);
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                const success = failure === undefined && testInfo.status === testInfo.expectedStatus;
                if (!success) {
                    await harness.diagnose(failure ?? testInfo.error);
                }
                await harness.close(success);
            }
        },
        runtime: async ({ stack, browserName, contextOptions, runtimeComputerName, runtimeAgent }, use) => {
            const runtime = await createTestRuntime(
                stack,
                browserName,
                contextOptions,
                runtimeComputerName,
                runtimeAgent,
            );
            try {
                await Promise.race([use(runtime), runtime.failure]);
            } finally {
                await runtime.close();
            }
        },
    });
}

export const test = runtimeTest();
