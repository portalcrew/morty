import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

const computerName = "Browser test Runtime — Engineering workstation with a long computer name";
test.use({ runtimeComputerName: computerName });

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 640, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 740 },
]) {
    test(`Given a paired chat at ${viewport.width}px, When the user opens and renames a conversation, Then its compact header and full execution details stay accessible`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        const phone = viewport.width < 640;
        const computer = page.getByRole("button", { name: `Switch computer, ${computerName}` });
        const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
        const viewDetails = phone
            ? page.getByRole("button", { name: `View execution details for ${computerName}`, exact: true })
            : page.getByRole("menuitem", { name: `View execution details for ${computerName}`, exact: true });
        const openDetails = async () => {
            await (phone ? navigation : computer).click();
            await expect(viewDetails).toBeVisible();
            expect((await viewDetails.boundingBox())?.height).toBeGreaterThanOrEqual(phone ? 44 : 24);
            await viewDetails.click();
        };
        if (!phone) {
            await expect(computer).toHaveAccessibleDescription("Connection available");
            await expect(computer).toContainText("Online");
        }
        await page.getByRole("textbox", { name: "Message" }).fill("Verify execution context");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("article", { name: "Agent response" })).toBeVisible();
        const title = page.getByRole("button", { name: "Verify execution context", exact: true });
        if (phone) {
            const navigationBox = await navigation.boundingBox();
            const titleBox = await title.boundingBox();
            if (navigationBox === null || titleBox === null) {
                throw new Error("Expected the header navigation and title");
            }
            expect(titleBox.y).toBeGreaterThanOrEqual(navigationBox.y);
            expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(navigationBox.y + navigationBox.height);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`connection-header-${viewport.width}.png`),
        });
        await title.click();
        await page
            .getByRole("textbox", { name: "Conversation title" })
            .fill("A renamed conversation with a long descriptive title");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`rename-conversation-${viewport.width}.png`),
        });
        await page.getByRole("button", { name: "Save title" }).click();
        await expect(
            page.getByRole("button", { name: "A renamed conversation with a long descriptive title", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "A renamed conversation with a long descriptive title", exact: true }),
        ).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        await openDetails();
        const dialog = page.getByRole("dialog", { name: "Execution details", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(computerName);
        await expect(dialog).toContainText("Claude Code");
        await expect(dialog).toContainText("Connected");
        await expect(dialog).toContainText("Online");
        if (phone) {
            await expect(dialog).toHaveCSS("transform", "none");
        }
        const fullPath = await dialog.getByTestId(dataTestId.executionDirectory).textContent();
        expect(fullPath).toMatch(/\/workspace$/);
        const box = await dialog.boundingBox();
        if (box === null) {
            throw new Error("Expected visible execution details");
        }
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        if (viewport.width < 640) {
            expect(box.y + box.height).toBe(viewport.height);
        }
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`execution-details-${viewport.width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        if (!phone) {
            await expect(computer).toBeFocused();
        }
        await page.reload();
        await expect(page.getByRole("article", { name: "Agent response" })).toBeVisible();
        await openDetails();
        await expect(dialog.getByTestId(dataTestId.executionDirectory)).toHaveText(fullPath ?? "missing directory");
        await dialog.getByRole("button", { name: "Close execution details" }).click();
        await expect(dialog).toBeHidden();
        if (!phone) {
            await expect(computer).toBeFocused();
        }
    });
}
