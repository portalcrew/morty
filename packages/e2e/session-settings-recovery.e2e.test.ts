import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test("Given a selected model, When the Computer restarts, Then the conversation and new-chat preference retain that selection", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Before the Computer restart");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Before the Computer restart");

    const configuration = page.getByRole("button", { name: "Configure agent" });
    await configuration.click();
    await page.getByRole("combobox", { name: "Model" }).click();
    await page.getByTestId(dataTestId.sessionConfigValue("test-large")).click();
    await page.keyboard.press("Escape");
    await expect(configuration).toContainText("Test Large");

    await runtime.restartRuntime();
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("button", { name: "Retry now" })).toBeHidden();
    await expect(configuration).toContainText("Test Large");

    await composer.fill("After the Computer restart");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
        page.getByRole("article", { name: "Agent response" }).filter({ hasText: "After the Computer restart" }),
    ).toBeVisible();
    await expect(configuration).toContainText("Test Large");
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("settings-after-restart.png") });

    await page.getByRole("button", { name: "New Session" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toHaveCount(0);
    await expect(configuration).toContainText("Test Large");
    await page.reload();
    await expect(configuration).toContainText("Test Large");
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("settings-new-chat-after-reload.png") });
});
