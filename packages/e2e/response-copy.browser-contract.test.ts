import { expect, test } from "./infra/test.ts";

test("Given the browser denies clipboard access, When I copy a response and then allow access, Then I receive manual-copy guidance and can retry successfully", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.clock.install({ time: new Date("2026-10-27T12:00:00Z") });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page
        .getByRole("article", { name: "Agent response" })
        .filter({ hasText: "The requested update is complete." });
    const copy = response.getByRole("button", { name: "Copy response", exact: true });
    await expect(copy).toBeVisible();
    const permissions = await page.context().newCDPSession(page);
    try {
        await permissions.send("Browser.setPermission", {
            permission: { name: "clipboard-write" },
            setting: "denied",
            origin: runtime.origin,
        });
        await copy.click();
        await expect(response.getByRole("alert")).toContainText("select the response and copy it manually");
        // The same copy button stays available to try again.
        await expect(copy).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath("response-copy-denied.png"), fullPage: true });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await copy.click();
        await expect(response.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        await expect(response.getByRole("alert")).toHaveCount(0);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("The requested update is complete.");
    } finally {
        await permissions.detach();
    }
});
