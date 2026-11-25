import { expect, test } from "./infra/test.ts";

test.use({ browserName: "chromium" });

test("Given a delayed session, When the user leaves or the measurement expires, Then the unfinished stage is reported without a visibility duration", async ({
    runtime,
}) => {
    const { page } = runtime;
    let holdSelection = false;
    const started = Promise.withResolvers<void>();
    await page.routeWebSocket("**/morty/api/v1/computers/*/transport", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((frame) => {
            if (holdSelection && typeof frame === "string" && frame.includes("/managed-sessions/resolve")) {
                started.resolve();
                return;
            }
            server.send(frame);
        });
    });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();
    const answer = page.getByText("The requested update is complete.", { exact: true });
    await expect(answer).toBeVisible();
    const chat = new URL(page.url());
    chat.pathname = "/chat";
    await page.goto(chat.href);
    await expect(answer).toBeInViewport();

    const draft = page.getByRole("button", { name: "New Session", exact: true });
    const saved = page.getByRole("button", { name: "Open distinguish agent work" });
    await draft.click();
    await page.clock.install({ time: new Date("2026-11-25T02:00:00Z") });
    holdSelection = true;
    const report = () =>
        page.waitForResponse((response) => response.url().endsWith("/morty/api/v1/metrics/session-open"));
    await saved.click();
    await started.promise;
    const cancelled = report();
    await draft.click();
    expect((await cancelled).request().postDataJSON()).toMatchObject({
        outcome: "cancelled",
        entry: "selection",
        openedToRequestMs: null,
        responseToVisibleMs: null,
    });

    await saved.click();
    const expired = report();
    await page.clock.fastForward(120_000);
    expect((await expired).request().postDataJSON()).toEqual({
        outcome: "timeout",
        entry: "selection",
        elapsedMs: 120_000,
        openedToRequestMs: null,
        requestToResponseMs: null,
        responseToVisibleMs: null,
    });
});

test("Given the browser blocks performance reporting, When I open a saved session, Then I can read and send messages", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();
    const answer = page.getByText("The requested update is complete.", { exact: true });
    await expect(answer).toBeVisible();
    const network = await page.context().newCDPSession(page);
    await network.send("Network.enable");
    await network.send("Network.setBlockedURLs", { urls: ["*/morty/api/v1/metrics/session-open"] });
    const blocked = page.waitForEvent("requestfailed", (request) =>
        request.url().endsWith("/morty/api/v1/metrics/session-open"),
    );
    const chat = new URL(page.url());
    chat.pathname = "/chat";
    await page.goto(chat.href);
    await expect(answer).toBeInViewport();
    await blocked;
    await page.getByRole("textbox", { name: "Message" }).fill("diagnostics unavailable");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
        page.getByRole("article", { name: "Agent response" }).filter({ hasText: "diagnostics unavailable" }),
    ).toBeVisible();
});
