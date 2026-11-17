import { expandMobileComposer } from "./infra/mobile-composer.ts";
import { expect, test } from "./infra/test.ts";
import type { createTestRuntime } from "./infra/test-runtime.ts";

type E2EPage = Awaited<ReturnType<typeof createTestRuntime>>["page"];

/** Tools sit behind each turn's step summary; expands every summary, including ones that streamed in since. */
async function expectTools(page: E2EPage, label: string, count: number) {
    await expect(async () => {
        const collapsed = page.getByRole("button", { name: /^\d+ steps?\b/u, expanded: false });
        for (let remaining = await collapsed.count(); remaining > 0; remaining = await collapsed.count()) {
            await collapsed.first().click();
        }
        await expect(page.getByLabel(label, { exact: true })).toHaveCount(count, { timeout: 1000 });
    }).toPass();
}

test.use({ runtimeAgent: { harness: "tool-lifecycle-test", name: "Tool Lifecycle Agent" } });
for (const width of [1440, 390]) {
    test(`Given a running tool at ${width}px, When I stop and reload the turn, Then unfinished tools are interrupted, the stop stays where it ended, and later turns preserve that outcome`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize({ width, height: 900 });
        await runtime.openPairedChat();
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("hold unfinished tools");
        await page.getByRole("button", { name: "Send message" }).click();
        await expectTools(page, "Tool running", 2);
        if (width < 640) {
            await expandMobileComposer(page);
        }
        await composer.fill("Add another verification");
        await page.getByRole("button", { name: "Send message" }).click();
        await page.getByRole("button", { name: "Steer queued message: Add another verification" }).click();
        await expectTools(page, "Tool running", 3);
        await page.getByRole("button", { name: "Stop agent output" }).click();
        await expectTools(page, "Tool interrupted", 3);
        await expect(page.getByText("Turn stopped.", { exact: true })).toBeVisible();
        await page.reload();
        await expectTools(page, "Tool running", 0);
        await expectTools(page, "Tool interrupted", 3);
        await expectTools(page, "Tool succeeded", 1);
        await expectTools(page, "Tool failed", 1);
        // History holds the turn's ending where it ended, so a reload shows the stop as the live view did.
        await expect(page.getByText("Turn stopped.", { exact: true })).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath(`stopped-tools-${width}.png`), fullPage: true });
        if (width < 640) {
            await expandMobileComposer(page);
        }
        await composer.fill("complete unfinished tools");
        await page.getByRole("button", { name: "Send message" }).click();
        await expectTools(page, "Tool interrupted", 5);
        await expectTools(page, "Tool running", 0);
        await expect(page.getByText("Turn stopped.", { exact: true })).toHaveCount(1);
    });
}
