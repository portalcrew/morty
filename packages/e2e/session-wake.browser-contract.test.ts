import type { WebSocketRoute } from "playwright-core";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a conversation recovering after suspension, when its history read times out, then it recovers automatically without cancelling or repeating the task", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    const historyHeld = Promise.withResolvers<() => void>();
    let holdHistory = false;
    const connections = new Set<WebSocketRoute>();
    await page.routeWebSocket("**/morty/api/v1/computers/*/transport", (socket) => {
        const server = socket.connectToServer();
        connections.add(socket);
        server.onMessage((message) => socket.send(message));
        socket.onClose(async (code, reason) => {
            connections.delete(socket);
            await server.close({
                ...(code === undefined ? {} : { code }),
                ...(reason === undefined ? {} : { reason }),
            });
        });
        socket.onMessage((message) => {
            const frame: unknown = typeof message === "string" ? JSON.parse(message) : null;
            if (
                holdHistory &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "method" in frame &&
                frame.method === "GET" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                new URL(frame.path, "https://relay.test").pathname.endsWith("/events")
            ) {
                holdHistory = false;
                historyHeld.resolve(() => server.send(message));
                return;
            }
            server.send(message);
        });
    });
    await runtime.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
    await runtime.clock.pauseAt(new Date("2026-10-28T08:01:00Z"));
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("hold after first delta");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Partial reply");
    await composer.fill("Keep this unsent draft after waking.");

    holdHistory = true;
    await Promise.all([...connections].map((socket) => socket.close({ code: 1001 })));
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeDisabled();
    await runtime.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished while the browser was suspended." }],
    });
    await page.evaluate(() => document.dispatchEvent(new Event("resume")));
    const releaseHistory = await historyHeld.promise;
    // The held read never reaches the Relay, so its deadline expires in virtual time while every forwarded
    // exchange, each heartbeat included, is answered before time moves on.
    await runtime.clock.runFor(45_000);
    // A read deadline is recoverable; it must not become a terminal cancellation.
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toContainText("Retrying in");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The disconnect and the read timeout consume two attempts: the second
    // bounded backoff is at most ten seconds, driven entirely by virtual time.
    await runtime.clock.runFor(10_000);
    await expect(page.getByTestId(dataTestId.sendMessage)).toBeEnabled();
    releaseHistory();
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(composer).toHaveValue("Keep this unsent draft after waking.");
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(1);
    await expect(
        page
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Finished while the browser was suspended." }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("wake-recovered.png") });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" }).last()).toContainText(
        "Codex turn 2: Keep this unsent draft after waking.",
    );
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2);
});

test("Given a reply streaming while the page is suspended, when the page resumes to deliveries older than their freshness window, then it shows the finished reply without a connection error", async ({
    runtime,
}) => {
    const { page } = runtime;
    // A suspended page runs no script, so frames its open socket receives wait until it resumes.
    let suspension: {
        readonly held: { readonly route: WebSocketRoute; readonly message: string | Buffer }[];
        readonly firstEvent: PromiseWithResolvers<void>;
    } | null = null;
    await page.routeWebSocket("**/morty/api/v1/computers/*/transport", (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
            if (suspension === null) {
                socket.send(message);
                return;
            }
            suspension.held.push({ route: socket, message });
            if (typeof message === "string" && message.includes('"session.events.event"')) {
                suspension.firstEvent.resolve();
            }
        });
        socket.onMessage((message) => server.send(message));
        socket.onClose(async (code, reason) => {
            await server.close({
                ...(code === undefined ? {} : { code }),
                ...(reason === undefined ? {} : { reason }),
            });
        });
    });
    await runtime.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
    await runtime.clock.pauseAt(new Date("2026-10-28T08:01:00Z"));
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("hold after first delta");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Partial reply");

    const firstEvent = Promise.withResolvers<void>();
    suspension = { held: [], firstEvent };
    await runtime.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished while the page was suspended." }],
    });
    await firstEvent.promise;
    // The page stayed suspended past the encrypted deliveries' freshness window.
    await runtime.clock.setFixedTime(new Date("2026-10-28T08:06:00Z"));
    const { held } = suspension;
    suspension = null;
    for (const { route, message } of held) {
        route.send(message);
    }
    await page.evaluate(() => document.dispatchEvent(new Event("resume")));

    const finished = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "Finished while the page was suspended." });
    await runtime.clock.advanceUntil(async () => {
        expect(await finished.count()).toBe(1);
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toBeHidden();
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
});

test("Given a reply finishing while the page is away for minutes and its connection silently died, when the page is shown again, then it reconnects at once and shows the reply", async ({
    runtime,
}) => {
    const { page } = runtime;
    const links = new Set<{ dead: boolean }>();
    await page.routeWebSocket("**/morty/api/v1/computers/*/transport", (socket) => {
        const server = socket.connectToServer();
        const link = { dead: false };
        links.add(link);
        server.onMessage((message) => {
            if (!link.dead) {
                socket.send(message);
            }
        });
        socket.onMessage((message) => {
            if (!link.dead) {
                server.send(message);
            }
        });
        socket.onClose(async (code, reason) => {
            await server.close({
                ...(code === undefined ? {} : { code }),
                ...(reason === undefined ? {} : { reason }),
            });
        });
    });
    await runtime.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
    await runtime.clock.pauseAt(new Date("2026-10-28T08:01:00Z"));
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("hold after first delta");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Partial reply");

    // The network dropped the connection while the page was away, and nothing told the page: the socket still reads
    // as open, but no frame crosses it either way.
    for (const link of links) {
        link.dead = true;
    }
    runtime.clock.holdOpenTransports();
    await runtime.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: "Finished while the connection was gone." }],
    });
    // Away for two minutes: no timer ran meanwhile, and the heartbeat due during that time fires once on return.
    await runtime.clock.fastForward(120_000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    const finished = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "Finished while the connection was gone." });
    // Longer than a heartbeat cycle without an answer means the connection is gone: no ten-second wait on it.
    await runtime.clock.advanceUntil(
        async () => {
            expect(await finished.count()).toBe(1);
        },
        { maximum: 5_000 },
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
});
