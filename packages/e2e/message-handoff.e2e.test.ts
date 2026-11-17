import { dataTestId } from "../web/src/data-testid.ts";
import { expandMobileComposer, expect, test } from "./infra/test.ts";

for (const mobile of [false, true]) {
    test.describe(mobile ? "Mobile" : "Desktop", () => {
        test.use({
            contextOptions: {
                viewport: { width: mobile ? 390 : 1280, height: 844 },
                isMobile: mobile,
                hasTouch: mobile,
            },
        });
        test("Given a new conversation, When I send a message and continue typing, Then one message is shown and the next draft survives in the focused composer", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await runtime.openPairedChat();
            const composer = page.getByRole("textbox", { name: "Message" });
            await composer.fill("Read my first message");
            await page.getByRole("button", { name: "Send message" }).click();
            await expandMobileComposer(page);
            await expect(composer).toHaveValue("");
            await expect(composer).toBeEnabled();
            await composer.fill("My next draft stays here");
            await expect(
                page.getByTestId(dataTestId.agentResponse).filter({ hasText: "Read my first message" }),
            ).toBeVisible();
            await expect(composer).toHaveValue("My next draft stays here");
            await expect(composer).toBeFocused();
            await expect(page.getByTestId(dataTestId.userMessage)).toHaveCount(1);
            await page.screenshot({ path: testInfo.outputPath("first-message-handoff.png"), fullPage: true });
            await page.getByRole("button", { name: "Send message" }).click();
            await expandMobileComposer(page);
            await expect(composer).toHaveValue("");
            await composer.fill("This third draft is still mine");
            await expect(
                page.getByTestId(dataTestId.agentResponse).filter({ hasText: "My next draft stays here" }),
            ).toBeVisible();
            await expect(composer).toHaveValue("This third draft is still mine");
            await expect(page.getByTestId(dataTestId.userMessage)).toHaveCount(2);
            await page.screenshot({ path: testInfo.outputPath("existing-session-handoff.png"), fullPage: true });
        });
    });
}
