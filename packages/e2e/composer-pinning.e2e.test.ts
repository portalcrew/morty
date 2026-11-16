import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { harness: "interaction-test", name: "Interaction Agent" } });

test.describe("composer stays pinned to the pane bottom", () => {
    // A short window leaves no room for the header, the answer card, and the
    // composer together, so the pane has to clip instead of scrolling.
    test("Given a short window with a pending answer, When I tab across the answer card, Then the composer stays inside the pane", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width: 865, height: 300 });
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("request text answers");
        await page.getByRole("button", { name: "Send message" }).click();

        const card = page.getByRole("dialog", { name: "Agent information request" });
        await expect(card).toBeVisible();
        await card.getByRole("button", { name: "Continue" }).focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");

        const pane = page.locator(`section[aria-label="Conversation"] section`).first();
        const header = page.locator(`section[aria-label="Conversation"] header`).first();
        const composer = page.getByRole("textbox", { name: "Message" }).locator("xpath=ancestor::form[1]");
        const interactionScroller = page.getByRole("region", { name: "Pending Agent requests" });
        await page.screenshot({ animations: "disabled", path: testInfo.outputPath("after-tab.png") });

        // The pane clips, so revealing a control can never scroll the header away.
        expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);

        const headerBox = await header.boundingBox();
        const paneBox = await pane.boundingBox();
        const composerBox = await composer.boundingBox();
        const scrollerBox = await interactionScroller.boundingBox();
        if (headerBox === null || paneBox === null || composerBox === null || scrollerBox === null) {
            throw new Error("Expected the header, pane, composer, and answer card to have layout boxes");
        }

        expect(headerBox.y - paneBox.y).toBeLessThan(2);
        expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 0.5);
        expect(paneBox.y + paneBox.height - (composerBox.y + composerBox.height)).toBeLessThan(16);

        expect(scrollerBox.height).toBeGreaterThan(0);
        expect(scrollerBox.y + scrollerBox.height).toBeLessThanOrEqual(composerBox.y + 0.5);
        const scroll = await interactionScroller.evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    });
});
