import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given an online computer, when the browser loses and regains its network, then the switcher and both computer lists agree", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.clock.install({ time: new Date("2026-10-29T00:00:00Z") });
    await runtime.openPairedChat();
    const switcher = page.getByRole("button", { name: /Switch computer/ });
    await expect(switcher).toHaveAttribute("data-connection-status", "connected");
    await switcher.click();
    const desktopChoice = page.getByRole("menuitemradio", { checked: true });
    await expect(desktopChoice).toContainText("Online");

    await page.context().setOffline(true);
    await expect(page.getByTestId(dataTestId.botConnectionStatus)).toHaveAttribute(
        "data-connection-status",
        "unavailable",
    );
    await expect(desktopChoice).toContainText("Unavailable");
    await expect(desktopChoice).not.toContainText("Online");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    const mobileChoice = page
        .getByRole("navigation", { name: "Computers" })
        .getByRole("button", { name: /^(Online )?Browser test Runtime/ });
    await expect(mobileChoice).toContainText("Unavailable");
    await expect(mobileChoice).not.toContainText("Online");

    await page.context().setOffline(false);
    await runtime.clock.runFor(5000);
    await expect(mobileChoice).toContainText("Online");
    await mobileChoice.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(switcher).toHaveAttribute("data-connection-status", "connected");
});
