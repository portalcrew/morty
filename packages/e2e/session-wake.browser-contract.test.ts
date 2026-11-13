import { mock } from "node:test";
import type { WebSocketRoute } from "playwright-core";
import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test.beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T08:01:00Z") });
});
test.afterEach(() => {
    mock.timers.reset();
});

test("Given a conversation recovering after suspension, when its history read times out, then it recovers automatically without cancelling or repeating the task", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    const historyHeld = Promise.withResolvers<() => void>();
    let holdHistory = false;
    const connections = new Set<WebSocketRoute>();
    let heartbeat: PromiseWithResolvers<void> | null = null;
    // Forward to the real Relay. Delay one real history request while
    // keeping subscription acknowledgements and heartbeats flowing.
    await page.routeWebSocket("**/morty/api/v1/computers/*/transport", (socket) => {
        const server = socket.connectToServer();
        connections.add(socket);
        server.onMessage((message) => {
            socket.send(message);
            if (message === '{"kind":"pong"}') {
                heartbeat?.resolve();
            }
        });
        socket.onClose(async (code, reason) => {
            connections.delete(socket);
            heartbeat?.resolve();
            await server.close({
                ...(code === undefined ? {} : { code }),
                ...(reason === undefined ? {} : { reason }),
            });
        });
        socket.onMessage((message) => {
            if (message === '{"kind":"ping"}') {
                heartbeat = Promise.withResolvers();
            }
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
    // Virtual time fires due timers back to back, while each heartbeat's pong is
    // real I/O. A live connection therefore advances in steps shorter than the
    // ten-second heartbeat deadline, each ending once the ping is answered.
    const stayConnectedFor = async (milliseconds: number) => {
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 5_000) {
            const step = Math.min(5_000, milliseconds - elapsed);
            await page.clock.runFor(step);
            mock.timers.tick(step);
            await heartbeat?.promise;
        }
    };
    await page.clock.install({ time: new Date("2026-10-28T08:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-28T08:01:00Z"));
    // Browser and real daemon share virtual system time so encrypted payloads remain fresh during timer advances.
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
    await stayConnectedFor(45_000);
    // A read deadline is recoverable; it must not become a terminal cancellation.
    await expect(page.getByTestId(dataTestId.sessionReconnectNotice)).toContainText("Retrying in");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The disconnect and the read timeout consume two attempts: the second
    // bounded backoff is at most ten seconds, driven entirely by virtual time.
    await stayConnectedFor(10_000);
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
