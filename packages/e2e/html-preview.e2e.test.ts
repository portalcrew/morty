import { interactiveHtml } from "../../tests/support/fake-daemon/html-preview.ts";
import { expect, test } from "./infra/test.ts";

test("Given an agent links an HTML result, When the user opens it, Then they can interact, inspect source and return to the conversation", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open delivery review" }).click();

    const preview = page.getByRole("dialog", { name: "Local file preview" });
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await expect(result.getByRole("heading", { name: "Delivery review" })).toBeVisible();
    await result.getByRole("textbox", { name: "Review name" }).fill("Desktop review");
    await result.getByRole("button", { name: "Review result" }).click();
    await expect(result.getByText("Desktop review complete", { exact: true })).toBeVisible();
    await expect(result.getByText("Reviews: 1", { exact: true })).toBeVisible();
    await preview.screenshot({ animations: "disabled", path: testInfo.outputPath("html-interactive-desktop.png") });

    const desktopViewport = page.viewportSize();
    if (desktopViewport === null) {
        throw new Error("Expected a desktop viewport");
    }
    await page.setViewportSize({ width: 560, height: desktopViewport.height });
    await expect(preview).toHaveCSS("width", "560px");
    await expect(preview.getByRole("button", { name: "Expand preview" })).toBeHidden();
    await expect(result.getByText("Reviews: 1", { exact: true })).toBeVisible();
    await page.setViewportSize(desktopViewport);
    await expect(preview.getByRole("button", { name: "Expand preview" })).toBeVisible();
    await expect(result.getByRole("textbox", { name: "Review name" })).toHaveValue("Desktop review");

    await preview.getByRole("button", { name: "View source", exact: true }).click();
    await expect(preview.getByRole("region", { name: "File contents" })).toContainText("<!doctype html>");
    await preview.getByRole("button", { name: "Show preview", exact: true }).click();
    await expect(result.getByText("Reviews: 0", { exact: true })).toBeVisible();

    await preview.getByRole("button", { name: "Expand preview", exact: true }).click();
    await expect(preview).toHaveCSS("width", `${page.viewportSize()?.width}px`);
    await page.setViewportSize({ width: 560, height: desktopViewport.height });
    await expect(preview).toHaveCSS("width", "560px");
    await page.setViewportSize(desktopViewport);
    await expect(preview.getByRole("button", { name: "Collapse preview" })).toBeVisible();
    await expect(preview).toHaveCSS("width", `${desktopViewport.width}px`);
    await preview.getByRole("button", { name: "Close file preview", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open delivery review" })).toBeVisible();
    await page.getByRole("button", { name: "Open delivery review" }).click();
    await expect(preview.getByRole("button", { name: "Expand preview" })).toBeVisible();
    await expect(result.getByText("Reviews: 0", { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(page.getByRole("button", { name: "Open delivery review" })).toBeFocused();
});

test.describe("touch preview", () => {
    test.use({
        contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    });
    test("Given a mobile user has reviewed an HTML result, When the local file changes and they reload, Then the new result opens at full width and their draft survives", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await runtime.openPairedChat();
        await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
        await page.getByRole("button", { name: "Send message" }).tap();
        await page.getByRole("button", { name: "Open delivery review" }).waitFor();
        await page.getByRole("button", { name: "Expand message composer" }).tap();
        await page.getByRole("textbox", { name: "Message" }).fill("Please refine this result");
        await page.getByRole("button", { name: "Open delivery review" }).tap();

        const preview = page.getByRole("dialog", { name: "Local file preview" });
        const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
        await expect(preview).toHaveCSS("width", "390px");
        await result.getByRole("textbox", { name: "Review name" }).fill("Phone review");
        await result.getByRole("button", { name: "Review result" }).tap();
        await expect(result.getByText("Phone review complete", { exact: true })).toBeVisible();
        await preview.screenshot({ animations: "disabled", path: testInfo.outputPath("html-interactive-mobile.png") });

        await page.setViewportSize({ width: 844, height: 390 });
        await expect(preview).toHaveCSS("width", "844px");
        await expect(result.getByText("Reviews: 1", { exact: true })).toBeVisible();
        await preview.screenshot({
            animations: "disabled",
            path: testInfo.outputPath("html-interactive-mobile-landscape.png"),
        });
        await page.setViewportSize({ width: 390, height: 844 });

        await runtime.writeFiles(
            new Map([
                [
                    "/workspace/delivery-review.html",
                    {
                        content: interactiveHtml.replaceAll("Delivery review", "Updated delivery"),
                        mediaType: "text/html",
                    },
                ],
            ]),
        );
        await preview.getByRole("button", { name: "Reload file" }).tap();
        await expect(result.getByRole("heading", { name: "Updated delivery" })).toBeVisible();
        await expect(result.getByText("Reviews: 0", { exact: true })).toBeVisible();
        await preview.getByRole("button", { name: "Close file preview" }).tap();
        await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Please refine this result");
        await expect(page.getByRole("button", { name: "Open delivery review" })).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath("html-mobile-return-to-conversation.png") });
    });
});

test("Given an agent links a local picture, When the user opens and reloads it, Then the existing image preview still renders", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("show preview image");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open picture" }).click();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    await expect(preview.getByRole("img", { name: "generated-picture.png" })).toBeVisible();
    await preview.getByRole("button", { name: "Reload file" }).click();
    await expect(preview.getByRole("img", { name: "generated-picture.png" })).toBeVisible();
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(preview).toBeHidden();
});

test("Given a keyboard user expands an interactive result, When they navigate and close it, Then focus stays in the visible preview and returns to the file link", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    const link = page.getByRole("button", { name: "Open delivery review" });
    await link.focus();
    await page.keyboard.press("Enter");

    const preview = page.getByRole("dialog", { name: "Local file preview" });
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await expect(preview.getByRole("button", { name: "Close file preview" })).toBeFocused();
    await result.getByRole("textbox", { name: "Review name" }).fill("Keyboard review");
    await result.getByRole("button", { name: "Review result" }).click();
    await preview.getByRole("button", { name: "Expand preview" }).click();
    await expect(result.getByText("Reviews: 1", { exact: true })).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    // Native dialogs may move focus to browser chrome at the boundary, but must
    // never focus the conversation underneath the full-screen preview.
    expect(
        await preview.evaluate(
            (element) => element.contains(document.activeElement) || document.activeElement === document.body,
        ),
    ).toBe(true);
    await result.getByRole("button", { name: "Review result" }).press("Tab");
    expect(
        await preview.evaluate(
            (element) => element.contains(document.activeElement) || document.activeElement === document.body,
        ),
    ).toBe(true);
    await preview.getByRole("button", { name: "Close file preview" }).press("Escape");
    await expect(preview).toBeHidden();
    await expect(link).toBeFocused();
});

test("Given a local HTML tool uses a form, When the user submits it and continues chatting, Then the tool works and preserves its state until they leave the session", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await runtime.writeFiles(
        new Map([
            [
                "/workspace/delivery-review.html",
                {
                    mediaType: "text/html",
                    content: `<!doctype html><html lang="en"><title>Quote calculator</title>
<form id="quote"><label for="quantity">Quantity</label>
<input id="quantity" type="number" min="1" value="1" required>
<button type="submit">Calculate quote</button></form>
<output id="total" aria-live="polite">Ready</output>
<script>
document.getElementById("quote").addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("total").textContent = "Total: " + Number(document.getElementById("quantity").value) * 25;
});
</script></html>`,
                },
            ],
        ]),
    );
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open delivery review" }).click();
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await result.getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await result.getByRole("button", { name: "Calculate quote" }).click();
    await expect(result.getByText("Total: 75", { exact: true })).toBeVisible();

    await composer.fill("Please keep this result");
    await composer.press("Enter");
    await expect(
        page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Please keep this result" }),
    ).toBeVisible();
    await expect(result.getByText("Total: 75", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New Session" }).click();
    await expect(page.getByRole("dialog", { name: "Local file preview" })).toBeHidden();
    await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
    await expect(composer).toHaveValue("");
});
