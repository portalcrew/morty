import { expect, type Page } from "@playwright/test";

/**
 * Taps the phone composer before a test types or inspects its draft. Only a focused composer stays open: an idle,
 * empty one collapses as soon as it is unfocused, so a still-disabled composer, which cannot take focus, is not open yet.
 */
export async function expandMobileComposer(page: Page): Promise<void> {
    if ((page.viewportSize()?.width ?? 640) >= 640) {
        return;
    }
    const expand = page.getByRole("button", { name: "Expand message composer" });
    const textbox = page.getByRole("textbox", { name: "Message" });
    await expect(async () => {
        if (!(await textbox.isVisible())) {
            await expand.click({ timeout: 2000 });
        }
        await textbox.focus({ timeout: 2000 });
        await expect(textbox).toBeFocused({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
}
