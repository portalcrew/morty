import { fileURLToPath } from "node:url";
import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { harness: "tool-lifecycle-test", name: "Tool Lifecycle Agent" } });
for (const width of [1440, 390]) {
    test(`Given a background tool at ${width}px, When its reply ends and the task later completes, Then the original card stays live and survives reload`, async ({
        runtime,
    }) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("start background verification");
        await page.getByRole("button", { name: "Send message" }).click();
        await page.getByRole("button", { name: "1 step · 1 running in background" }).click();
        await expect(page.getByText("Running in background", { exact: true })).toBeVisible();
        if (width < 640) {
            await page.getByRole("button", { name: "Expand message composer" }).click();
        }
        await expect(composer).toBeEnabled();
        await page.screenshot({
            path: fileURLToPath(new URL(`../../test-results/background-running-${width}.png`, import.meta.url)),
            fullPage: true,
        });
        await composer.fill("finish background verification completed");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByText("Completed", { exact: true })).toBeVisible();
        await page.reload();
        await page.getByRole("button", { name: "1 step", exact: true }).click();
        await expect(page.getByText("Completed", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Tool: Background verification", { exact: true })).toHaveCount(1);
        await page.screenshot({
            path: fileURLToPath(new URL(`../../test-results/background-completed-${width}.png`, import.meta.url)),
            fullPage: true,
        });
    });
}
