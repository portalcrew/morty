import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { dataTestId } from "../web/src/data-testid.ts";
import { test as base, conversationLoaded, expect } from "./infra/test.ts";

type Gate = {
    readonly reached: Promise<void>;
    readonly release: () => void;
};
type Network = {
    readonly url: string;
    readonly interrupt: () => void;
    readonly gateHistory: (direction: "request" | "response") => Gate;
};

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;
}

function parseFrame(data: { readonly toString: () => string }): Readonly<Record<string, unknown>> | null {
    try {
        return record(JSON.parse(data.toString()));
    } catch {
        return null;
    }
}

// A stateful network fault proxy. It forwards the real requests and responses
// unchanged, preserving order in each direction; the only fault is a gate that
// pauses one direction. No application data or server responses are invented.
const test = base.extend<{ readonly network: Network }>({
    network: async ({ browserName, stack }, use) => {
        if (browserName !== "webkit") {
            throw new Error("These recovery contracts target mobile WebKit");
        }
        const pairs = new Set<{
            readonly client: WebSocket;
            readonly upstream: WebSocket;
            readonly session: boolean;
        }>();
        const requestIds = new Set<string>();
        let gate: {
            readonly direction: "request" | "response";
            readonly reached: () => void;
            readonly wait: Promise<void>;
        } | null = null;
        const target = new URL(stack.chatOrigin);
        const server = createServer((incoming, outgoing) => {
            const requested = new URL(incoming.url ?? "/", target);
            const upstream = request(
                target,
                {
                    path: requested.pathname + requested.search,
                    method: incoming.method,
                    headers: { ...incoming.headers, host: target.host },
                },
                (response) => {
                    outgoing.writeHead(response.statusCode ?? 502, response.headers);
                    response.pipe(outgoing);
                },
            );
            upstream.on("error", () => outgoing.destroy());
            incoming.pipe(upstream);
        });
        const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
        server.on("upgrade", (incoming, socket, head) => {
            const requested = new URL(incoming.url ?? "/", target);
            const endpoint = new URL(target);
            endpoint.pathname = requested.pathname;
            endpoint.search = requested.search;
            endpoint.protocol = "ws:";
            websocketServer.handleUpgrade(incoming, socket, head, (client) => {
                const headers = Object.fromEntries(
                    Object.entries(incoming.headers).filter(
                        ([name]) =>
                            !["host", "connection", "upgrade"].includes(name.toLowerCase()) &&
                            !name.toLowerCase().startsWith("sec-websocket-"),
                    ),
                );
                const upstream = new WebSocket(endpoint, { headers, perMessageDeflate: false });
                const pair = { client, upstream, session: endpoint.pathname.endsWith("/transport") };
                pairs.add(pair);
                const opened = new Promise<void>((resolve, reject) => {
                    upstream.once("open", resolve);
                    upstream.once("error", reject);
                });
                // A client can leave before it sends its first frame or the upstream opens.
                void opened.catch(() => client.terminate());
                let outbound = Promise.resolve();
                let inbound = Promise.resolve();
                client.on("message", (data, isBinary) => {
                    outbound = outbound
                        .then(async () => {
                            await opened;
                            const frame = parseFrame(data);
                            const history =
                                frame?.["kind"] === "http.request" &&
                                frame["method"] === "GET" &&
                                typeof frame["path"] === "string" &&
                                frame["path"].includes("/events?");
                            if (history && typeof frame?.["requestId"] === "string") {
                                requestIds.add(frame["requestId"]);
                            }
                            if (pair.session && history && gate?.direction === "request") {
                                const held = gate;
                                gate = null;
                                held.reached();
                                await held.wait;
                            }
                            if (upstream.readyState === WebSocket.OPEN) {
                                upstream.send(data, { binary: isBinary });
                            }
                        })
                        .catch(() => client.terminate());
                });
                upstream.on("message", (data, isBinary) => {
                    inbound = inbound
                        .then(async () => {
                            const frame = parseFrame(data);
                            const history =
                                frame?.["kind"] === "http.response" &&
                                typeof frame["requestId"] === "string" &&
                                requestIds.has(frame["requestId"]);
                            if (pair.session && history && gate?.direction === "response") {
                                const held = gate;
                                gate = null;
                                held.reached();
                                await held.wait;
                            }
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(data, { binary: isBinary });
                            }
                        })
                        .catch(() => upstream.terminate());
                });
                client.on("error", () => upstream.terminate());
                upstream.on("error", () => client.terminate());
                client.on("close", () => {
                    pairs.delete(pair);
                    upstream.terminate();
                });
                upstream.on("close", () => {
                    pairs.delete(pair);
                    client.terminate();
                });
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing proxy address");
        }
        try {
            await use({
                url: `http://127.0.0.1:${address.port}`,
                interrupt: () => {
                    for (const pair of pairs) {
                        if (pair.session) {
                            pair.client.terminate();
                        }
                    }
                },
                gateHistory: (direction) => {
                    const reached = Promise.withResolvers<void>();
                    const resume = Promise.withResolvers<void>();
                    gate = { direction, reached: reached.resolve, wait: resume.promise };
                    return { reached: reached.promise, release: resume.resolve };
                },
            });
        } finally {
            for (const pair of pairs) {
                pair.client.terminate();
                pair.upstream.terminate();
            }
            websocketServer.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
    contextOptions: async ({ network }, use) => {
        await use({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            proxy: { server: network.url },
        });
    },
});

test.use({ browserName: "webkit" });

for (const schedule of ["before-snapshot", "after-snapshot", "after-recovery"] as const) {
    test(`Given a streaming reply, when a real delta arrives ${schedule}, then recovery displays every delta exactly once`, async ({
        runtime,
        network,
    }, testInfo) => {
        testInfo.setTimeout(90000);
        const { page } = runtime;
        const wire: unknown[] = [];
        const observed = new Set<string>();
        const waiters = new Map<string, () => void>();
        const recoveredHistory = Promise.withResolvers<void>();
        let phase = "initial";
        const capture = (value: unknown, kind: string): void => {
            if (Array.isArray(value)) {
                for (const child of value) {
                    capture(child, kind);
                }
                return;
            }
            const item = record(value);
            if (item === null) {
                return;
            }
            const payload = record(item["payload"]);
            const content = record(payload?.["content"]);
            if (
                typeof item["eventId"] === "string" &&
                payload?.["sessionUpdate"] === "agent_message_chunk" &&
                typeof content?.["text"] === "string"
            ) {
                wire.push({
                    phase,
                    kind,
                    eventId: item["eventId"],
                    position: item["position"] ?? null,
                    generation: item["sessionGenerationId"],
                    text: content["text"],
                });
                if (phase === "recovery" && kind === "http.response") {
                    recoveredHistory.resolve();
                }
                if (kind === "session.events.event") {
                    observed.add(content["text"]);
                    waiters.get(content["text"])?.();
                }
            }
            for (const child of Object.values(item)) {
                capture(child, kind);
            }
        };
        page.on("websocket", (socket) => {
            if (!new URL(socket.url()).pathname.endsWith("/transport")) {
                return;
            }
            socket.on("framereceived", ({ payload }) => {
                const frame = parseFrame(payload);
                if (frame?.["kind"] === "http.response" && typeof frame["body"] === "string") {
                    try {
                        capture(JSON.parse(frame["body"]), frame["kind"]);
                    } catch {
                        /* Not history. */
                    }
                }
                if (frame?.["kind"] === "session.events.event" && typeof frame["data"] === "string") {
                    capture(JSON.parse(frame["data"]), frame["kind"]);
                }
            });
        });
        const waitForDelta = (text: string): Promise<void> =>
            observed.has(text) ? Promise.resolve() : new Promise((resolve) => waiters.set(text, resolve));
        await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
        const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
        await page.goto(connected.url);
        const composer = page.getByRole("textbox", { name: "Message" });
        const responses = page.getByRole("article", { name: "Agent response" });
        await expect(composer).toBeEnabled();
        await conversationLoaded(page);
        await composer.fill("wait for steering");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(responses).toContainText("Waiting for steering");
        const gate =
            schedule === "after-recovery"
                ? null
                : network.gateHistory(schedule === "before-snapshot" ? "request" : "response");
        phase = "recovery";
        // Recovery runs quietly first: the page offers no manual retry while it reconnects on its own.
        network.interrupt();
        const resumed = page.clock.runFor(5000);
        if (gate !== null) {
            await gate.reached;
            await runtime.continueReply("wait for steering", {
                outcome: "hold",
                output: [{ kind: "text", text: "|B|" }],
            });
            if (schedule === "before-snapshot") {
                await waitForDelta("|B|");
            }
            gate.release();
        }
        await resumed;
        await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
        if (schedule === "after-recovery") {
            // Recovery is initially quiet, so a hidden notice does not establish that
            // the new connection has consumed its history snapshot.
            await recoveredHistory.promise;
            await runtime.continueReply("wait for steering", {
                outcome: "hold",
                output: [{ kind: "text", text: "|B|" }],
            });
        }
        await waitForDelta("|B|");
        phase = "continued";
        await runtime.continueReply("wait for steering", {
            outcome: "complete",
            output: [{ kind: "text", text: "|C_END|" }],
        });
        await expect(responses).toContainText("|C_END|");
        await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
        const beforeReload = await responses.allTextContents();
        await page.screenshot({ path: testInfo.outputPath("before-reload.png") });
        expect.soft(beforeReload.join("").match(/\|B\|/g)?.length ?? 0).toBe(1);
        phase = "reload";
        await page.reload();
        await expect(responses).toContainText("|C_END|");
        const afterReload = await responses.allTextContents();
        expect.soft(afterReload.join("").match(/\|B\|/g)?.length ?? 0).toBe(1);
        expect.soft(beforeReload).toEqual(afterReload);
        await page.screenshot({ path: testInfo.outputPath("after-reload.png") });
        await testInfo.attach("snapshot-recovery", {
            body: JSON.stringify({ schedule, beforeReload, afterReload, wire }),
            contentType: "application/json",
        });
    });
}

test("Given a partial reply, when it finishes while the browser is disconnected, then recovery displays the same complete reply as a reload", async ({
    runtime,
    network,
}) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    const responses = page.getByRole("article", { name: "Agent response" });
    await expect(composer).toBeEnabled();
    await conversationLoaded(page);
    await composer.fill("wait for steering");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(responses).toContainText("Waiting for steering");
    await composer.fill("Preserve this draft.");
    // Recovery runs quietly first: the page offers no manual retry while it reconnects on its own.
    network.interrupt();
    await runtime.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "|OFFLINE_END|" }],
    });
    await page.clock.runFor(5000);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(responses).toContainText("Waiting for steering|OFFLINE_END|");
    await expect(composer).toHaveValue("Preserve this draft.");
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
    const recovered = await responses.allTextContents();
    await page.reload();
    await expect(responses).toContainText("|OFFLINE_END|");
    expect(await responses.allTextContents()).toEqual(recovered);
});

test("Given the user has loaded older messages, when the connection recovers, then the loaded history, reading position and draft remain available", async ({
    runtime,
    network,
}) => {
    const { page } = runtime;
    await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
    const connected = await runtime.followInstructions("/setup.md", "setup-reconnect-session");
    await page.goto(connected.url);
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("status", { name: "Loading messages", exact: true })).toBeHidden();
    for (let index = 1; index <= 7; index += 1) {
        await composer.fill(`many session events: Saved message ${index}`);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
            `Completed Saved message ${index}`,
        );
        await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
    }
    await page.reload();
    const messages = page.getByRole("article", { name: "Your message" });
    await expect(messages.last()).toContainText("Saved message 7");
    const initial = await messages.allTextContents();
    expect(initial.length).toBeLessThan(7);
    const log = page.getByRole("log", { name: "Messages" });
    await log.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
    });
    await expect(messages).not.toHaveCount(initial.length);
    await expect(page.getByRole("status", { name: "Loading older messages" })).toBeHidden();
    const loaded = await messages.allTextContents();
    expect(loaded.length).toBeGreaterThan(initial.length);
    await composer.fill("Keep my history draft.");
    const reading = messages.nth(1);
    await reading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const before = await reading.boundingBox();
    // Recovery runs quietly first: the page offers no manual retry while it reconnects on its own.
    network.interrupt();
    await page.clock.runFor(5000);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    expect(await messages.allTextContents()).toEqual(loaded);
    await expect(composer).toHaveValue("Keep my history draft.");
    expect(await reading.boundingBox()).toEqual(before);
});
