import { expect, test } from "./infra/test.ts";

test("Given a saved conversation, When I reopen it, Then its first visible history reports one segmented duration", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();
    const answer = page.getByText("The requested update is complete.", { exact: true });
    await expect(answer).toBeVisible();

    const reported = page.waitForResponse((response) => response.url().endsWith("/morty/api/v1/metrics/session-open"));
    const chat = new URL(page.url());
    chat.pathname = "/chat";
    await page.goto(chat.href);
    await expect(answer).toBeInViewport();
    const response = await reported;
    expect(response.status()).toBe(204);
    const headers = await response.request().allHeaders();
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["referer"]).toBe(`${new URL(response.url()).origin}/`);
    const sample = response.request().postDataJSON();
    expect(sample).toEqual({
        entry: "navigation",
        outcome: "visible",
        openedToRequestMs: expect.any(Number),
        requestToResponseMs: expect.any(Number),
        responseToVisibleMs: expect.any(Number),
        elapsedMs: expect.any(Number),
    });
    expect(sample.openedToRequestMs + sample.requestToResponseMs + sample.responseToVisibleMs).toBe(sample.elapsedMs);

    await page.getByRole("button", { name: "New Session", exact: true }).click();
    const switched = page.waitForResponse((reply) => reply.url().endsWith("/morty/api/v1/metrics/session-open"));
    await page.getByRole("button", { name: "Open distinguish agent work" }).click();
    await expect(answer).toBeInViewport();
    expect((await switched).request().postDataJSON()).toMatchObject({ entry: "selection", outcome: "visible" });
});
