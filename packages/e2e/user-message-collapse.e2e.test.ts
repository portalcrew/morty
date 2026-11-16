import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

test.use({ runtimeAgent: { harness: "settings-test", name: "Settings Agent" } });

test("Given a long user message, When I open and close its body, Then the text stays available without expanding a short message", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    const longMessage = Array.from(
        { length: 20 },
        (_, index) => `Paragraph ${String(index + 1)}: This line makes the message body tall enough to fold.`,
    ).join("\n\n");
    await page.getByRole("textbox", { name: "Message" }).fill(longMessage);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId(dataTestId.agentResponse).filter({ hasText: "Paragraph 20" })).toBeVisible();

    const longBubble = page.getByRole("article", { name: "Your message" }).filter({ hasText: "Paragraph 20" });
    const showMore = longBubble.getByRole("button", { name: "Show more" });
    await expect(showMore).toBeVisible();
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    const bodyId = await showMore.getAttribute("aria-controls");
    if (bodyId === null) {
        throw new Error("The disclosure must identify its message body");
    }
    await expect(showMore).toHaveAttribute("aria-controls", bodyId);
    await expect
        .poll(() =>
            showMore.evaluate((button) => {
                return document.getElementById(button.getAttribute("aria-controls") ?? "")?.style.maxHeight;
            }),
        )
        .toBe("264px");

    await showMore.click();
    const showLess = longBubble.getByRole("button", { name: "Show less" });
    await expect(showLess).toHaveAttribute("aria-expanded", "true");
    await expect
        .poll(() =>
            showLess.evaluate((button) => {
                return document.getElementById(button.getAttribute("aria-controls") ?? "")?.style.maxHeight;
            }),
        )
        .not.toBe("264px");
    await showLess.click();
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    await expect
        .poll(() =>
            showMore.evaluate((button) => {
                return document.getElementById(button.getAttribute("aria-controls") ?? "")?.style.maxHeight;
            }),
        )
        .toBe("264px");

    await page.getByRole("button", { name: "New Session" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("Short user message");
    await page.getByRole("button", { name: "Send message" }).click();
    const shortBubble = page.getByRole("article", { name: "Your message" }).filter({ hasText: "Short user message" });
    await expect(shortBubble).toBeVisible();
    await expect(shortBubble.getByRole("button", { name: "Show more" })).toHaveCount(0);
});
