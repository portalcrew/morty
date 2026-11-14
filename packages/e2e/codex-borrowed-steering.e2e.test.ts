import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chromium, firefox, webkit } from "playwright-core";
import { CodexAppServerClient } from "../../packages/cli/src/engine/acp/harness/codex/app-server-client.ts";
import { ComputerEncryptionStore } from "../../packages/cli/src/engine/runtime/connection/computer-encryption-store.ts";
import { stopProcessTree } from "../../packages/cli/src/engine/util/process/executable.ts";
import { CodexFixture } from "../../packages/cli/tests/support/agents/codex.ts";
import { FakeOpenAiProvider } from "../../packages/cli/tests/support/llm/openai.ts";
import { TestComputerHost } from "../cli/tests/support/computer-host.ts";
import { dataTestId } from "../web/src/data-testid.ts";
import { ChatApi, object, text } from "./infra/chat-api.ts";
import { E2EHarness } from "./infra/harness.ts";
import { LocalStack } from "./infra/local-stack.ts";

// Keep CI's WebKit coverage; allow local verification where the OS's frozen WebKit is unsupported.
const selectedBrowser = process.env["MORTY_E2E_BORROWED_BROWSER"] ?? "webkit";
if (selectedBrowser !== "webkit" && selectedBrowser !== "chromium") {
    throw new Error("MORTY_E2E_BORROWED_BROWSER must be webkit or chromium");
}
test.use({ browserName: selectedBrowser, contextOptions: { isMobile: true, hasTouch: true } });

// Both Codex processes and the daemon are real. Only model responses are controlled.
test("Given desktop Codex owns a conversation, When I open it in Morty and queue follow-ups, Then steering is unavailable and the queued replies complete", async ({
    browserName,
    contextOptions,
}, testInfo) => {
    const harness = await E2EHarness.create("codex-borrowed-steering");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([harness.signal, cancellation.signal]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "BORROWED_REPLY", {
        beforeFirstText: async () => {
            if (hold) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using codex = await CodexFixture.create(provider);
    let running: Promise<void> | undefined;
    let owner: CodexAppServerClient | undefined;
    let success = false;
    try {
        const stack = await LocalStack.create(harness);
        await stack.start();
        const environment = codex.environment;
        const completed = Promise.withResolvers<void>();
        owner = new CodexAppServerClient({
            command: codex.executable,
            cwd: stack.directories.workspace,
            environment,
            handlers: {
                onNotification: async (method) => {
                    if (method === "turn/completed") {
                        completed.resolve();
                    }
                },
                onServerRequest: async () => {},
            },
        });
        await owner.initialize(signal);
        const started = object(
            await owner.request(
                "thread/start",
                { cwd: stack.directories.workspace, model: "morty-test-model" },
                signal,
            ),
            "started thread",
        );
        const threadId = text(object(started["thread"], "thread")["id"], "thread ID");
        await owner.request(
            "turn/start",
            { threadId, input: [{ type: "text", text: "Desktop conversation", text_elements: [] }] },
            signal,
        );
        await completed.promise;

        const chat = new ChatApi(stack.chatOrigin, signal);
        const { computerId } = await chat.createIdentity();
        const pairing = await chat.createPairing();
        const engine = new TestComputerHost({
            dataDirectory: join(harness.workDirectory, "computer"),
            agentLaunchEnvironment: environment,
        });
        const paired = await engine.pair(
            {
                defaultWorkspace: stack.directories.workspace,
                pairingCode: text(pairing["pairingCode"], "pairing code"),
                computerId: text(pairing["computerId"], "pairing ID"),
                relayOrigin: text(pairing["relayUrl"], "relay URL"),
            },
            signal,
        );
        const ready = Promise.withResolvers<void>();
        running = engine.runLoop({
            pairingGeneration: paired.pairingGeneration,
            signal,
            onConnectionStatus: (status) => {
                if (status === "online") {
                    ready.resolve();
                }
            },
        });
        void running.catch(ready.reject);
        await Promise.race([ready.promise, running]);
        await chat.readPairedAgent("codex");
        const encryption = await ComputerEncryptionStore.open(
            join(harness.workDirectory, "computer"),
            computerId,
            signal,
        );
        const access = await encryption.access(signal);
        await harness.stage("verify-codex", () => chat.bindAgent("codex", access));
        // The harness owns the browser so a failure keeps its trace, page and browser events.
        const browser = await harness.stage(`launch-${browserName}`, () =>
            ({ chromium, firefox, webkit })[browserName].launch({ headless: true }),
        );
        const page = await (async () => {
            try {
                const context = await harness.stage("create-browser-context", () => browser.newContext(contextOptions));
                const opened = await harness.stage("open-browser-page", () => context.newPage());
                await harness.stage("trace-browser", () => harness.attachBrowser(browser, context, opened));
                return opened;
            } catch (error) {
                await browser.close();
                throw error;
            }
        })();
        const handoff = await harness.stage("issue-browser-handoff", () => chat.browserHandoff(access));
        await page.goto(handoff);
        await page.getByRole("button", { name: "Open Session", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Open Session" });
        await dialog.getByTestId(dataTestId.localSessionEntry).first().click();
        await dialog.getByRole("button", { name: "Open", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

        await page.setViewportSize({ width: 390, height: 844 });
        hold = true;
        await owner.request(
            "turn/start",
            { threadId, input: [{ type: "text", text: "Owner still working", text_elements: [] }] },
            signal,
        );
        await entered.promise;
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("First remote follow-up");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
        await composer.fill("Second remote follow-up");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const steer = page.getByRole("button", { name: "Steer queued message: Second remote follow-up", exact: true });
        await expect(steer).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Delete queued message: Second remote follow-up", exact: true }),
        ).toBeEnabled();
        await page.reload();
        await expect(steer).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath("borrowed-queue.png"), fullPage: true });
        release.resolve();
        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(page.getByTestId(dataTestId.queuedMessage)).toHaveCount(0);
        await expect(
            page.getByText("The target turn finished before steering could be injected", { exact: true }),
        ).toHaveCount(0);
        const history = await owner.request("thread/read", { threadId, includeTurns: true }, signal);
        expect(JSON.stringify(history)).toContain("First remote follow-up");
        expect(JSON.stringify(history)).toContain("Second remote follow-up");
        await expect(
            page.getByRole("article", { name: "Agent response" }).filter({ hasText: "BORROWED_REPLY" }).last(),
        ).toBeVisible();
        success = true;
    } catch (cause) {
        await harness.diagnose(cause);
        throw cause;
    } finally {
        release.resolve();
        cancellation.abort();
        await running?.catch(() => undefined);
        if (owner !== undefined) {
            owner.detach();
            await stopProcessTree(owner.child());
        }
        await harness.close(success);
    }
});
