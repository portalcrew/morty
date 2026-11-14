import { expect, test } from "./infra/test.ts";

const composerMaxHeightPx = 256;

test.describe("message composer resizing", () => {
    test("Given a long multiline draft, When the composer grows, Then the whole composer caps at 256px and fades only clipped edges", async ({
        runtime,
    }) => {
        const { page } = runtime;
        await runtime.openPairedChat();
        const composer = page.getByRole("textbox", { name: "Message" });
        const scrollArea = composer.locator("xpath=ancestor::*[@data-slot='scroll-area']");
        const composerSurface = scrollArea.locator("xpath=ancestor::div[contains(@class, 'max-h-64')]");
        const scrollViewport = scrollArea.locator('[data-slot="scroll-area-viewport"]');
        const fades = composerSurface.locator('div.relative > [aria-hidden="true"]');
        const fadeOpacities = async () =>
            await fades.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).opacity));
        const expectFadeOpacities = async (first: string, second: string) => {
            await expect(fades.nth(0)).toHaveCSS("opacity", first);
            await expect(fades.nth(1)).toHaveCSS("opacity", second);
        };

        await composer.fill("short draft");
        await expect(composer).toHaveCSS("margin-bottom", "8px");
        await expect(composerSurface).toHaveCSS("max-height", "256px");
        const shortHeight = await composerSurface.evaluate((element) => element.getBoundingClientRect().height);
        expect(shortHeight).toBeLessThan(composerMaxHeightPx);
        expect(await fadeOpacities()).toEqual(["0", "0"]);

        await composer.fill(Array.from({ length: 30 }, (_, index) => `line ${(index + 1).toString()}`).join("\n"));
        const grown = await composerSurface.evaluate((element) => ({
            height: element.getBoundingClientRect().height,
        }));
        const scroll = await scrollViewport.evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));
        expect(grown.height).toBe(composerMaxHeightPx);
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expectFadeOpacities("1", "0");

        await scrollViewport.evaluate((element) => {
            element.scrollTop = 0;
        });
        await expectFadeOpacities("0", "1");

        await scrollViewport.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expectFadeOpacities("1", "0");

        await expect(scrollArea.locator('[data-slot="scroll-area-scrollbar"]')).toHaveAttribute(
            "data-state",
            "visible",
        );
        const inset = await scrollArea.evaluate((element) => {
            const composer = element.closest("form")?.querySelector("div.max-h-64");
            const scrollbar = element.querySelector('[data-slot="scroll-area-scrollbar"]');
            if (composer === null || composer === undefined || scrollbar === null) {
                return null;
            }
            const composerBox = composer.getBoundingClientRect();
            const scrollbarBox = scrollbar.getBoundingClientRect();
            return {
                left: element.getBoundingClientRect().left - composerBox.left,
                right: composerBox.right - element.getBoundingClientRect().right,
                scrollbarInset: element.getBoundingClientRect().right - scrollbarBox.right,
            };
        });
        if (inset === null) {
            throw new Error("Expected the composer and its scrollbar to have layout boxes");
        }
        expect(Math.abs(inset.left - inset.right)).toBeLessThan(0.5);
        expect(Math.abs(inset.scrollbarInset)).toBeLessThan(0.5);
        const bottomFadeGap = await composerSurface.evaluate((element) => {
            const bottomFade = element.querySelector('[aria-hidden="true"]:last-of-type');
            const toolbar = element.querySelector("div.mt-1");
            if (bottomFade === null || toolbar === null) {
                return Number.POSITIVE_INFINITY;
            }
            return toolbar.getBoundingClientRect().top - bottomFade.getBoundingClientRect().bottom;
        });
        expect(Math.abs(bottomFadeGap)).toBeLessThan(0.5);
    });

    test("Given a long draft with an attachment, When the composer is at its cap, Then the text viewport ends above the toolbar", async ({
        runtime,
    }) => {
        const { page } = runtime;
        await runtime.openPairedChat();
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("Attachment draft");
        await page.getByLabel("Choose attachments").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Attachment contents for notes.txt"),
        });
        await expect(page.getByRole("list", { name: "Attachments" })).toContainText("notes.txt");

        await composer.fill(Array.from({ length: 30 }, (_, index) => `line ${(index + 1).toString()}`).join("\n"));
        const scrollArea = composer.locator("xpath=ancestor::*[@data-slot='scroll-area']");
        const scrollViewport = scrollArea.locator('[data-slot="scroll-area-viewport"]');
        const boxes = await scrollViewport.evaluate((element) => {
            const surface = element.closest("div.max-h-64");
            const toolbar = surface?.querySelector("div.mt-1");
            if (!(surface instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) {
                return null;
            }
            return {
                surfaceHeight: surface.getBoundingClientRect().height,
                toolbarTop: toolbar.getBoundingClientRect().top,
                viewportBottom: element.getBoundingClientRect().bottom,
            };
        });
        if (boxes === null) {
            throw new Error("Expected the composer surface and its toolbar to have layout boxes");
        }
        expect(boxes.surfaceHeight).toBe(composerMaxHeightPx);
        expect(boxes.viewportBottom).toBeLessThanOrEqual(boxes.toolbarTop);
        // The clipped draft still scrolls inside the reduced text region.
        const scroll = await scrollViewport.evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }));
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    });
});
