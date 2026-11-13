import { join } from "node:path";
import { type BrowserContextOptions, chromium, firefox, webkit } from "playwright-core";
import { mortyFiles, mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../../web/src/services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope } from "../../web/src/services/identity/identity-scope-url.ts";
import { anonymousCreationKey, ChatApi, jsonRequest, object, text } from "./chat-api.ts";
import type { LocalStack } from "./local-stack.ts";
import { ControlledSetupRuntime } from "./setup-daemon.ts";
import { followSetupInstructions } from "./setup-instructions.ts";

export async function createTestRuntime(
    stack: LocalStack,
    browserName: "chromium" | "firefox" | "webkit" = "chromium",
    contextOptions: BrowserContextOptions = {},
    computerName = "Browser test Runtime",
    agent: { readonly harness: string; readonly name: string } = { harness: "claude", name: "Claude Code" },
) {
    const journey = stack.harness;
    const setupClockStart = Date.parse("2026-09-15T12:00:00Z");
    let setupClockTime = setupClockStart;
    const harness = agent.harness;
    const agentName = agent.name;
    const runtime = new ControlledSetupRuntime(
        {
            harness,
            agentName,
            files: mortyFiles,
            reply: mortyReply,
            // Match Web/Worker fixtures: the daemon records the submitted
            // prompt, so this controlled Agent does not echo it again.
            echoUserMessage: true,
            sessionIds: new Set(["setup-reconnect-session"]),
        },
        computerName,
    );
    const additionalRuntimes: ControlledSetupRuntime[] = [];
    const additionalFailure = Promise.withResolvers<never>();
    void additionalFailure.promise.catch(() => undefined);
    const browser = await { chromium, firefox, webkit }[browserName].launch({ headless: true });
    try {
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await journey.attachBrowser(browser, context, page);
        const chat = new ChatApi(stack.chatOrigin, journey.signal);

        const openChat = async () => {
            const identity = object(
                await jsonRequest(stack.chatOrigin, "/morty/api/v1/computers", {
                    body: { creationKey: anonymousCreationKey() },
                    signal: journey.signal,
                }),
                "anonymous identity",
            );
            const token = text(identity["computerToken"], "Computer token");
            const computerId = text(identity["computerId"], "computerId");

            const url = new URL(stack.chatOrigin);
            url.searchParams.set("identity", encodeIdentityScope({ computerId }));
            await page.addInitScript(
                ({ key, scope, token }) => {
                    if (window === window.top) {
                        const raw = window.localStorage.getItem(key);
                        const stored = raw === null ? { credentials: {}, computers: [] } : JSON.parse(raw);
                        window.localStorage.setItem(
                            key,
                            JSON.stringify({
                                credentials: { ...stored.credentials, [scope.computerId]: token },
                                computers: [
                                    ...stored.computers.filter(
                                        (computer: { scope: { computerId: string } }) =>
                                            computer.scope.computerId !== scope.computerId,
                                    ),
                                    { scope },
                                ],
                            }),
                        );
                    }
                },
                { key: ANONYMOUS_CREDENTIAL_KEY_NAME, scope: { computerId }, token },
            );
            await page.goto(url.href);
            const user = await chat.useBrowserIdentity({ computerId, computerToken: token });
            return { computerId: user.computerId };
        };

        return {
            close: async () => {
                await Promise.all([runtime, ...additionalRuntimes].map((computer) => computer.disconnect()));
            },
            failure: Promise.race([runtime.failure, additionalFailure.promise]),
            continueReply: runtime.continueReply,
            writeFiles: runtime.writeFiles,
            page,
            origin: stack.chatOrigin,
            openChat,
            openPairedChat: async (computerName?: string) => {
                const computer =
                    computerName === undefined
                        ? runtime
                        : new ControlledSetupRuntime(
                              {
                                  harness,
                                  agentName,
                                  files: mortyFiles,
                                  reply: mortyReply,
                                  echoUserMessage: true,
                              },
                              computerName,
                          );
                if (computer !== runtime) {
                    additionalRuntimes.push(computer);
                    void computer.failure.catch(additionalFailure.reject);
                }
                await openChat();
                const pairing = await chat.createPairing();
                await computer.pair(
                    journey.workDirectory,
                    {
                        relayOrigin: text(pairing["relayUrl"], "relay URL"),
                        computerId: text(pairing["computerId"], "pairing ID"),
                        pairingCode: text(pairing["pairingCode"], "pairing code"),
                        workspace: stack.directories.workspace,
                    },
                    journey.signal,
                );
                await chat.readPairedAgent(harness);
                await chat.bindAgent(harness);
                await chat.readBinding(harness);
                await page.reload();
            },
            disconnectRuntime: async () => await runtime.disconnect(),
            restartRuntime: async () => await runtime.restart(),
            pauseRuntime: runtime.pause,
            resumeRuntime: runtime.resume,
            forgetRuntimeConnections: async () => await runtime.forgetConnections(),
            connectUnrelatedRuntime: async () => {
                const unrelated = new ChatApi(stack.chatOrigin, journey.signal);
                await unrelated.useBrowserIdentity(
                    await jsonRequest(stack.chatOrigin, "/morty/api/v1/computers", {
                        body: { creationKey: anonymousCreationKey() },
                        signal: journey.signal,
                    }),
                );
                const pairing = await unrelated.createPairing();
                await runtime.pair(
                    journey.workDirectory,
                    {
                        relayOrigin: text(pairing["relayUrl"], "relay URL"),
                        computerId: text(pairing["computerId"], "pairing ID"),
                        pairingCode: text(pairing["pairingCode"], "pairing code"),
                        workspace: stack.directories.workspace,
                    },
                    journey.signal,
                );
                await unrelated.readPairedAgent(harness);
            },
            followInstructions: async (
                instructionUrl: string,
                sessionId?: string,
                maximumWaitMilliseconds?: number,
                workspace?: string,
                replaceComputer?: string,
            ) => {
                const url = new URL(instructionUrl, stack.chatOrigin);
                if (sessionId !== undefined && harness !== "claude") {
                    throw new Error(`No harness session variable is modeled for the ${harness} agent`);
                }
                setupClockTime = setupClockStart;
                const result = await followSetupInstructions({
                    instructionUrl: url.href,
                    cwd: workspace ?? stack.directories.workspace,
                    state: join(journey.workDirectory, "morty-state"),
                    harness,
                    signal: journey.signal,
                    clock: {
                        now: () => new Date(setupClockTime),
                        wait: async (milliseconds, signal) => {
                            signal.throwIfAborted();
                            setupClockTime += milliseconds;
                            if (
                                maximumWaitMilliseconds !== undefined &&
                                setupClockTime - setupClockStart > maximumWaitMilliseconds
                            ) {
                                throw new Error("Controlled setup exceeded its deterministic wait limit");
                            }
                        },
                    },
                    runtime,
                    ...(replaceComputer === undefined ? {} : { replaceComputer }),
                    // A Claude Code shell exposes its current session; the controlled peer stands in for Claude Code.
                    agentEnvironment: sessionId === undefined ? {} : { CLAUDE_CODE_SESSION_ID: sessionId },
                });
                return {
                    computerId: text(result.ready["computerId"], "ready computer"),
                    configuration: result.configuration,
                    events: result.events,
                    url: text(result.ready["url"], "Chat URL"),
                    qrPath: typeof result.ready["qrPath"] === "string" ? result.ready["qrPath"] : null,
                    workspace: text(result.ready["workspace"], "Runtime working directory"),
                    message: text(result.ready["message"], "ready message"),
                    identity: result.identity,
                };
            },
        };
    } catch (error) {
        await runtime.disconnect();
        await browser.close();
        throw error;
    }
}
