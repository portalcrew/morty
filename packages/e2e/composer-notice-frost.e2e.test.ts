import { writeFileSync } from "node:fs";
import { expect, test } from "./infra/test.ts";

test("Given a session pinned to its latest reply, When an unreadable attachment raises the composer notice, Then the reply tail stays fully above the notice", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const composer = page.getByRole("textbox", { name: "Message" });
    // Fill the log past its viewport so the latest reply pins to its bottom edge,
    // where the notice floats; short conversations leave empty container space.
    for (let turn = 1; turn <= 8; turn += 1) {
        await composer.fill(`Notice tuck reply ${turn} `.repeat(12));
        await page.getByRole("button", { name: "Send message" }).click();
    }
    const article = page.getByRole("article", { name: "Agent response" }).last();
    await expect(article.getByRole("button", { name: "Copy response" })).toBeVisible();

    // A zero-byte file fails the attachment size check and raises the notice.
    const empty = testInfo.outputPath("empty.txt");
    writeFileSync(empty, "");
    await page.locator("input[aria-label='Choose attachments']").setInputFiles(empty);
    const notice = page.locator('[data-notice-placement="overlay"]');
    await expect(
        notice.getByRole("alert").filter({ hasText: "Files must be between 1 byte and 32 MB." }),
    ).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("notice-frost.png") });

    // The notice no longer overlaps the log at all: the log's visible box stops
    // at the notice's top edge, so no scroll position — not just the pinned
    // bottom — passes under its frost, and the latest reply keeps its whole
    // tail, text and copy action, above the notice.
    const noticeBox = await notice.boundingBox();
    const articleBox = await article.boundingBox();
    const logBox = await page.getByRole("log").boundingBox();
    if (noticeBox === null || articleBox === null || logBox === null) {
        throw new Error("Expected the notice, the latest reply and the log to have layout boxes");
    }
    expect(logBox.y + logBox.height).toBeLessThanOrEqual(noticeBox.y + 1);
    expect(articleBox.y + articleBox.height).toBeLessThanOrEqual(noticeBox.y);
    await expect(article.getByRole("button", { name: "Copy response" })).toBeInViewport();
});

test.describe("Given an interactive card ending the log", () => {
    // A short pane makes the first-session tip the tail of an overflowing log —
    // the state where the reply-tail frost sink would pull a card under the notice.
    test.use({ contextOptions: { viewport: { width: 1280, height: 320 } } });

    test("When an unreadable attachment raises the composer notice, Then the card keeps its actions fully above the notice", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        const connected = await runtime.followInstructions("/doc/setup.md", "setup-reconnect-session");
        await page.goto(connected.url);
        const tip = page.getByRole("region", { name: "Continue your work here" });
        await expect(tip).toBeVisible();

        // A zero-byte file fails the attachment size check and raises the notice.
        const empty = testInfo.outputPath("empty.txt");
        writeFileSync(empty, "");
        await page.locator("input[aria-label='Choose attachments']").setInputFiles(empty);
        const notice = page.locator('[data-notice-placement="overlay"]');
        await expect(
            notice.getByRole("alert").filter({ hasText: "Files must be between 1 byte and 32 MB." }),
        ).toBeVisible();
        await page.screenshot({ animations: "disabled", path: testInfo.outputPath("notice-card-tail.png") });

        // The tip is a card with actions, not reply chrome: it never sinks into
        // the frost. The log reserves the notice's overlap below the card, so
        // its bottom edge stays clear of the notice and its action is reachable.
        const tipBox = await tip.boundingBox();
        const noticeBox = await notice.boundingBox();
        if (tipBox === null || noticeBox === null) {
            throw new Error("Expected the tip and the notice to have layout boxes");
        }
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(noticeBox.y);
        await expect(tip.getByRole("button", { name: "Ask for a progress update" })).toBeInViewport();
    });
});
