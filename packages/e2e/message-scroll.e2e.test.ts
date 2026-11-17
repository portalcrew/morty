import { expect, test } from "./infra/test.ts";

for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
]) {
    test.describe(`message scrolling at ${viewport.width}px`, () => {
        test.use({ contextOptions: { viewport, reducedMotion: "reduce" } });

        test("Given a long reply, When I scroll and jump to the latest message, Then the reply remains readable above the composer", async ({
            runtime,
        }, testInfo) => {
            const { page } = runtime;
            await runtime.openPairedChat();
            const prompt = [
                "Reply beginning",
                ...Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}: Read the complete conversation.`),
                "Reply ending",
            ].join("\n\n");
            await page.getByRole("textbox", { name: "Message" }).fill(prompt);
            await page.getByRole("button", { name: "Send message" }).click();

            const response = page.getByRole("article", { name: "Agent response" });
            const ending = response.getByText("Reply ending", { exact: true });
            await expect(ending).toBeAttached();
            await expect(ending).toBeInViewport();
            const log = page.getByRole("log", { name: "Messages" });
            const box = await log.boundingBox();
            if (box === null) {
                throw new Error("Expected the message log to have a layout box");
            }
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, -100_000);
            await expect(ending).not.toBeInViewport();
            const jump = page.getByRole("button", { name: "Jump to latest message", exact: true });
            await expect(jump).toBeVisible();

            await page.mouse.wheel(0, 100_000);
            await expect(ending).toBeInViewport();
            await page.mouse.wheel(0, -100_000);
            await expect(ending).not.toBeInViewport();
            await jump.click();
            await expect(ending).toBeInViewport();
            const composer =
                viewport.width < 640
                    ? page.getByRole("button", { name: "Expand message composer" })
                    : page.getByRole("textbox", { name: "Message" });
            const composerBox = await composer.boundingBox();
            const endingBox = await ending.boundingBox();
            if (composerBox === null || endingBox === null) {
                throw new Error("Expected the reply tail and composer to have layout boxes");
            }
            expect(endingBox.y + endingBox.height).toBeLessThanOrEqual(composerBox.y);
            await page.screenshot({ path: testInfo.outputPath("message-tail.png") });
        });
    });
}
