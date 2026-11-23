import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chromium, firefox, webkit } from "playwright-core";
import {
    CodexAppServerClient,
    type CodexAppServerServerRequest,
} from "../../packages/cli/src/engine/acp/harness/codex/app-server-client.ts";
import { ComputerEncryptionStore } from "../../packages/cli/src/engine/runtime/connection/computer-encryption-store.ts";
import { spawnProcess, stopProcessTree } from "../../packages/cli/src/engine/util/process/executable.ts";
import { CodexFixture } from "../../packages/cli/tests/support/agents/codex.ts";
import { FakeOpenAiProvider } from "../../packages/cli/tests/support/llm/openai.ts";
import { createOwnerApi } from "../../tests/support/owner-api.ts";
import { connectSharedCodex } from "../cli/src/engine/acp/harness/codex/shared-server.ts";
import { waitForFile } from "../cli/tests/support/acp-process.ts";
import { TestComputerHost } from "../cli/tests/support/computer-host.ts";
import { dataTestId } from "../web/src/data-testid.ts";
import { ChatApi, object, text } from "./infra/chat-api.ts";
import { E2EHarness } from "./infra/harness.ts";
import { LocalStack } from "./infra/local-stack.ts";
import { expandMobileComposer } from "./infra/mobile-composer.ts";

// Keep CI's WebKit coverage; allow local verification where the OS's frozen WebKit is unsupported.
const selectedBrowser = process.env["MORTY_E2E_BORROWED_BROWSER"] ?? "webkit";
if (selectedBrowser !== "webkit" && selectedBrowser !== "chromium") {
    throw new Error("MORTY_E2E_BORROWED_BROWSER must be webkit or chromium");
}
test.use({ browserName: selectedBrowser, contextOptions: { isMobile: true, hasTouch: true } });

test("A phone opens a running desktop Codex turn on its shared server, steers and stops it", async ({
    browserName,
    contextOptions,
}) => {
    const harness = await E2EHarness.create("codex-shared-turn");
    const cancellation = new AbortController();
    const restarted = new AbortController();
    const signal = AbortSignal.any([harness.signal, cancellation.signal]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const detachGate = Promise.withResolvers<void>();
    const lossGate = Promise.withResolvers<void>();
    const approvalPrompt = "Run both approval checks";
    const commands = ["echo shared-desktop-decision", "echo shared-phone-decision"].map((cmd) => ({
        cmd,
        sandbox_permissions: "require_escalated",
        justification: "Check the shared Codex approval",
    }));
    const toolSequence = commands.map((command) => ({
        name: "exec",
        input: `text(await tools.exec_command(${JSON.stringify(command)}));`,
    }));
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "SHARED_REPLY", {
        toolPrompt: approvalPrompt,
        toolSequence,
        beforeFirstText: async (_signal, conversation) => {
            if (conversation.includes("Desktop continues after Morty exits")) {
                await detachGate.promise;
            }
            if (conversation.includes("Task interrupted by server loss")) {
                await lossGate.promise;
            }
            if (hold) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using codex = await CodexFixture.create(provider, {
        approvalPolicy: "on-request",
        configuredModel: "morty-test-model",
    });
    let shortHome: string | undefined;
    let daemon: ReturnType<typeof spawnProcess> | undefined;
    let running: Promise<void> | undefined;
    let owner: CodexAppServerClient | undefined;
    let peer: ReturnType<typeof createOwnerApi> | undefined;
    let success = false;
    try {
        const stack = await LocalStack.create(harness);
        await stack.start();
        const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "morty-sc-"));
        shortHome = directory;
        const home = join(directory, "codex");
        await symlink(codex.environment["CODEX_HOME"] ?? "", home);
        const environment = { ...codex.environment, CODEX_HOME: home };
        await mkdir(join(home, "app-server-control"), { mode: 0o700, recursive: true });
        daemon = spawnProcess(codex.executable, ["app-server", "--listen", "unix://"], {
            cwd: stack.directories.workspace,
            env: environment,
            stdio: "ignore",
        });
        await waitForFile(join(home, "app-server-control"), "app-server-control.sock", signal);
        const socket = await connectSharedCodex(environment, signal);
        if (!socket) {
            throw new Error("Test daemon did not start");
        }
        const completed = Promise.withResolvers<void>();
        const interrupted = Promise.withResolvers<string>();
        const approvals: CodexAppServerServerRequest[] = [];
        owner = new CodexAppServerClient({
            socket,
            command: codex.executable,
            cwd: stack.directories.workspace,
            environment,
            handlers: {
                onNotification: async (method, params) => {
                    if (method === "turn/completed") {
                        completed.resolve();
                        const turn = object(object(params, "params")["turn"], "turn");
                        if (turn["status"] === "interrupted") {
                            interrupted.resolve(text(turn["id"], "id"));
                        }
                    }
                },
                onServerRequest: async (request) => {
                    approvals.push(request);
                },
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

        const available = provider.diagnostics().at(-1)?.tools ?? [];
        if (!available.some((tool) => tool.name === "exec")) {
            const shell = available.find((tool) => tool.name.endsWith("exec_command"));
            if (!shell) {
                throw new Error("Codex did not expose a shell command");
            }
            for (const [index, command] of commands.entries()) {
                toolSequence[index] = { name: shell.name, input: JSON.stringify(command) };
            }
        }
        hold = true;
        const active = object(
            await owner.request(
                "turn/start",
                { threadId, input: [{ type: "text", text: "Desktop live task", text_elements: [] }] },
                signal,
            ),
            "start",
        );
        const activeId = text(object(active["turn"], "turn")["id"], "id");
        await entered.promise;
        const chat = new ChatApi(stack.chatOrigin, signal);
        const { computerId, token } = await chat.createIdentity();
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
        const stop = page.getByRole("button", { name: "Stop agent output", exact: true });
        await expect(stop).toBeEnabled();
        // Two different native threads share the same process and workspace.
        const neighbor = object(
            await owner.request(
                "thread/start",
                { cwd: stack.directories.workspace, model: "morty-test-model" },
                signal,
            ),
            "neighbor",
        );
        const neighborId = text(object(neighbor["thread"], "thread")["id"], "id");
        const other = object(
            await owner.request(
                "turn/start",
                {
                    threadId: neighborId,
                    input: [{ type: "text", text: "Independent desktop task", text_elements: [] }],
                },
                signal,
            ),
            "start",
        );
        const otherId = text(object(other["turn"], "turn")["id"], "id");
        const composer = page.getByRole("textbox", { name: "Message" });
        await expandMobileComposer(page);
        await composer.fill("Extra instructions from phone");
        await page.getByRole("button", { name: "Send message", exact: true }).tap();
        const steer = page.getByRole("button", {
            name: "Steer queued message: Extra instructions from phone",
            exact: true,
        });
        await expect(steer).toBeEnabled();
        // The desktop keeps working while the phone has no network. Its accepted queue survives reconnect.
        const context = page.context();
        await context.setOffline(true);
        const unreachable = await page.evaluate(async () => {
            try {
                await fetch(`${location.origin}/?offline-check=${crypto.randomUUID()}`, { cache: "no-store" });
                return false;
            } catch {
                return true;
            }
        });
        expect(unreachable).toBe(true);
        await context.setOffline(false);
        await page.reload();
        await expect(steer).toBeEnabled();
        await steer.tap();
        await expect(steer).toBeHidden();
        const target = { harness: "codex", sessionId: threadId };
        peer = createOwnerApi({ origin: stack.chatOrigin, computerId, credential: token, encryptionAccess: access });
        const client = await peer.sessionClient(target, signal);
        const previous = (await client.sessions.readSessionExecution(target, signal)).turn;
        if (!previous) {
            throw new Error("Morty did not expose the desktop turn");
        }
        await stop.tap();
        expect(await interrupted.promise).toBe(activeId);
        const unaffected = object(
            await owner.request("thread/turns/list", { threadId: neighborId, limit: 1, itemsView: "summary" }, signal),
            "neighbor turns",
        );
        expect(unaffected["data"]).toEqual([expect.objectContaining({ id: otherId, status: "inProgress" })]);
        await expect(stop).toBeHidden();
        const state = object(await owner.request("thread/read", { threadId, includeTurns: true }, signal), "read");
        expect(JSON.stringify(state)).toContain("interrupted");
        hold = false;
        release.resolve();
        await context.setOffline(true);
        const approvalTurn = await owner.request(
            "turn/start",
            {
                threadId,
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                sandboxPolicy: { type: "readOnly" },
                input: [{ type: "text", text: approvalPrompt, text_elements: [] }],
            },
            signal,
        );
        const approvalTurnId = text(object(object(approvalTurn, "response")["turn"], "turn")["id"], "id");
        const permission = page.getByRole("alertdialog", { name: "Agent permission request" });
        await expect
            .poll(
                () => approvals.filter((request) => request.method === "item/commandExecution/requestApproval").length,
            )
            .toBe(1);
        await context.setOffline(false);
        await expect(permission).toContainText("shared-desktop-decision");
        await expect(owner.request("turn/interrupt", { threadId, turnId: activeId }, signal)).rejects.toThrow();
        await client.turns.cancel(target, previous.commandId, signal);
        await expect(permission).toContainText("shared-desktop-decision");
        const pending = approvals.find((r) => r.method === "item/commandExecution/requestApproval");
        if (!pending) {
            throw new Error("The desktop did not see the approval");
        }
        owner.respond(pending.id, { decision: "decline" });
        await expect(permission).toContainText("shared-phone-decision");
        await permission.getByRole("button", { name: /^Allow( once)?$/u }).click();
        await expect(permission).toBeHidden();
        const desktop = owner;
        await expect
            .poll(async () => {
                const { thread } = object(
                    await desktop.request("thread/read", { threadId, includeTurns: true }, signal),
                    "read",
                );
                const { turns } = object(thread, "thread");
                if (!Array.isArray(turns)) {
                    throw new Error("Missing desktop history");
                }
                return turns.find((turn) => object(turn, "turn")["id"] === approvalTurnId)?.status;
            })
            .toBe("completed");
        const continuing = object(
            await owner.request(
                "turn/start",
                { threadId, input: [{ type: "text", text: "Desktop continues after Morty exits", text_elements: [] }] },
                signal,
            ),
            "start",
        );
        const continuingId = text(object(continuing["turn"], "turn")["id"], "id");
        await expect(stop).toBeEnabled();
        await page.reload();
        await expect(stop).toBeEnabled();
        client.close();
        cancellation.abort();
        await running;
        const history = async () => {
            const read = object(
                await desktop.request(
                    "thread/turns/list",
                    { threadId, limit: 1, itemsView: "summary" },
                    harness.signal,
                ),
                "read",
            );
            if (!Array.isArray(read["data"])) {
                throw new Error("Missing native turns");
            }
            return object(read["data"][0], "latest turn");
        };
        expect(await history()).toMatchObject({ id: continuingId, status: "inProgress" });
        // Reuse the saved pairing with a fresh Runtime and browser view, and recover the native turn.
        const reconnected = Promise.withResolvers<void>();
        running = engine.runLoop({
            pairingGeneration: paired.pairingGeneration,
            signal: AbortSignal.any([harness.signal, restarted.signal]),
            onConnectionStatus: (status) => {
                if (status === "online") {
                    reconnected.resolve();
                }
            },
        });
        await Promise.race([reconnected.promise, running]);
        await page.reload();
        await expect(stop).toBeEnabled();
        await stop.tap();
        await expect.poll(history).toMatchObject({ id: continuingId, status: "interrupted" });
        await expect(stop).toBeHidden();
        detachGate.resolve();
        await desktop.request(
            "turn/start",
            { threadId, input: [{ type: "text", text: "Task interrupted by server loss", text_elements: [] }] },
            harness.signal,
        );
        await expect(stop).toBeEnabled();
        await stopProcessTree(daemon);
        daemon = undefined;
        await expect(stop).toBeHidden();
        lossGate.resolve();
        await page.reload();
        await expandMobileComposer(page);
        await expect(composer).toBeEnabled();
        const replies = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "SHARED_REPLY" });
        const previousReplies = await replies.count();
        await composer.fill("Continue after server restart");
        await page.getByRole("button", { name: "Send message", exact: true }).tap();
        await expect(replies).toHaveCount(previousReplies + 1, { timeout: 85000 });
        await expect(stop).toBeHidden();
        expect(new URL(page.url()).searchParams.get("sessionId")).toBe(threadId);
        success = true;
    } catch (cause) {
        await harness.diagnose(cause);
        throw cause;
    } finally {
        lossGate.resolve();
        restarted.abort();
        peer?.close();
        detachGate.resolve();
        release.resolve();
        cancellation.abort();
        await running?.catch(() => undefined);
        if (owner !== undefined) {
            owner.detach();
        }
        if (daemon) {
            await stopProcessTree(daemon);
        }
        if (shortHome) {
            await rm(shortHome, { recursive: true, force: true });
        }
        await harness.close(success);
    }
});
