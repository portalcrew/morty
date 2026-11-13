import { expect, test } from "./infra/test.ts";

test("Given an agent answer with reasoning and a tool call, When the user inspects the agent work, Then every process row shares compact hover disclosure styling", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();

    const response = page.getByRole("article", { name: "Agent response" }).filter({
        hasText: "The requested update is complete.",
    });
    const answer = response.getByText("The requested update is complete.", { exact: true });
    const reasoningSummary = page.getByText("Show Thinking", { exact: true });
    const toolDisclosure = page.getByRole("button", { name: "Inspect workspace Tool succeeded" });
    await expect(answer).toBeVisible();
    const answerColor = await answer.evaluate((element) => getComputedStyle(element).color);
    const stepDisclosure = page.getByRole("button", { name: "1 step", exact: true });
    const stepChevron = stepDisclosure.locator("svg").last();
    const stepTitle = stepDisclosure.getByText("1 step", { exact: true });
    const stepIcon = stepDisclosure.locator("svg").first();
    const assertChevronFollowsTitle = async (
        row: typeof stepDisclosure,
        title: typeof stepTitle,
        chevron: typeof stepChevron,
    ) => {
        const rowBox = await row.boundingBox();
        const titleBox = await title.boundingBox();
        const chevronBox = await chevron.boundingBox();
        if (rowBox === null || titleBox === null || chevronBox === null) {
            throw new Error("Expected process row, title, and chevron to have layout boxes");
        }
        const chevronGap = chevronBox.x - (titleBox.x + titleBox.width);
        expect(chevronGap).toBeGreaterThanOrEqual(0);
        expect(chevronGap).toBeLessThan(32);
    };

    if ((await stepDisclosure.getAttribute("aria-expanded")) === "true") {
        await stepDisclosure.click();
    }
    await page.mouse.move(0, 0);
    const collapsedStepColor = await stepDisclosure.evaluate((element) => getComputedStyle(element).color);
    expect(collapsedStepColor).not.toBe(answerColor);
    await expect(stepChevron).toBeHidden();
    await expect(stepIcon).toHaveCSS("color", collapsedStepColor);

    // The collapsed summary first proves the shared hover contract before it
    // reveals the reasoning and tool rows it contains.
    await stepDisclosure.hover();
    await expect(stepChevron).toBeVisible();
    const hoveredStepColor = await stepDisclosure.evaluate((element) => getComputedStyle(element).color);
    expect(hoveredStepColor).not.toBe(collapsedStepColor);
    await expect(stepIcon).toHaveCSS("color", hoveredStepColor);
    await assertChevronFollowsTitle(stepDisclosure, stepTitle, stepChevron);

    await stepDisclosure.click();
    await page.mouse.move(0, 0);

    const reasoningRow = page.locator("summary").filter({ hasText: "Show Thinking" });
    const rows = [
        {
            chevronAlwaysVisible: false,
            row: reasoningRow,
            title: reasoningRow.getByText("Show Thinking", { exact: true }),
        },
        {
            chevronAlwaysVisible: false,
            row: toolDisclosure,
            title: toolDisclosure.getByText("Inspect workspace", { exact: true }),
        },
        { chevronAlwaysVisible: true, row: stepDisclosure, title: stepTitle },
    ];
    const initialRowColor = await reasoningRow.evaluate((element) => getComputedStyle(element).color);
    expect(initialRowColor).not.toBe(answerColor);
    for (const { row } of rows) {
        await expect(row).toHaveCSS("color", initialRowColor);
        await expect(row).toHaveCSS("margin-left", "-8px");
        await expect(row).toHaveCSS("margin-right", "-8px");
        await expect(row).toHaveCSS("padding-left", "8px");
        await expect(row).toHaveCSS("padding-right", "8px");
        const initialIconColor = await row
            .locator("svg")
            .first()
            .evaluate((element) => getComputedStyle(element).color);
        expect(initialIconColor).toBe(initialRowColor);
    }
    const rowHeights = await Promise.all(
        rows.map(async ({ row }) => {
            const box = await row.boundingBox();
            if (box === null) {
                throw new Error("Expected every agent process row to have a layout box");
            }
            return box.height;
        }),
    );
    expect(new Set(rowHeights.map((height) => Math.round(height))).size).toBe(1);
    expect(Math.round(rowHeights[0] ?? 0)).toBe(32);

    for (const { chevronAlwaysVisible, row, title } of rows) {
        const chevron = row.locator("svg").last();
        await page.mouse.move(0, 0);
        if (chevronAlwaysVisible) {
            await expect(chevron).toBeVisible();
        } else {
            await expect(chevron).toBeHidden();
        }
        const initialTextColor = await row.evaluate((element) => getComputedStyle(element).color);
        const initialIconColor = await row
            .locator("svg")
            .first()
            .evaluate((element) => getComputedStyle(element).color);
        await row.hover();
        await expect(chevron).toBeVisible();
        const hoveredTextColor = await row.evaluate((element) => getComputedStyle(element).color);
        const hoveredIconColor = await row
            .locator("svg")
            .first()
            .evaluate((element) => getComputedStyle(element).color);
        expect(hoveredTextColor).not.toBe(initialTextColor);
        expect(hoveredIconColor).toBe(hoveredTextColor);
        expect(hoveredIconColor).not.toBe(initialIconColor);
        await assertChevronFollowsTitle(row, title, chevron);
    }

    await toolDisclosure.hover();
    await page.screenshot({ fullPage: true, path: testInfo.outputPath("agent-work.png") });
    await reasoningSummary.click();
    const reasoning = page.getByText("Inspecting the request before acting.", { exact: true });
    await expect(reasoning).toBeVisible();
    await expect(reasoning).not.toHaveCSS("color", answerColor);
});

test.describe("elapsed time across reloads", () => {
    test("Given a working reply, When the user reloads after 65 seconds, Then elapsed time and live content remain consistent", async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await runtime.clock.setFixedTime(new Date("2026-10-13T08:00:00Z"));
        await runtime.openPairedChat();

        await page.getByRole("textbox", { name: "Message" }).fill("First conversation");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page).toHaveURL((url) => url.searchParams.has("sessionId"));
        const workingConversation = page.getByRole("button", { name: /First conversation.*Session working/u });
        const firstConversationResponse = page
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "First conversation" });
        await expect(firstConversationResponse).toHaveCount(1);
        await expect(firstConversationResponse).toBeVisible();

        await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
        await expect(workingConversation).toBeHidden();
        const sessionUrl = page.url();
        await page.reload();
        await expect(page).toHaveURL(sessionUrl);
        await expect(firstConversationResponse).toHaveCount(1);
        await expect(firstConversationResponse).toBeVisible();

        await page.getByRole("button", { name: "New Session" }).click();
        await page.getByRole("textbox", { name: "Message" }).fill("hold after first delta");
        await page.getByRole("button", { name: "Send message" }).click();
        const partialResponse = page
            .getByRole("article", { name: "Agent response" })
            .filter({ hasText: "Partial reply" });
        await expect(partialResponse).toHaveCount(1);
        await expect(partialResponse).toBeVisible();
        // The scenario links a file that is not in the workspace, so its block reports that it cannot be loaded.
        const linkedFile = "Content could not be loaded: partial.bin";
        await expect(page.getByText(linkedFile, { exact: true })).toBeVisible();
        const activeSessionUrl = page.url();
        await runtime.clock.setFixedTime(new Date("2026-10-13T08:01:05Z"));
        await page.reload();
        await expect(page.getByRole("status", { name: "Agent is working" })).toHaveText("Working for 1min 5s");
        await page.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-primary.png") });

        const secondPage = await page.context().newPage();
        try {
            await secondPage.clock.setFixedTime(new Date("2026-10-13T08:01:05Z"));
            await secondPage.goto(activeSessionUrl);
            const secondPagePartialResponse = secondPage
                .getByRole("article", { name: "Agent response" })
                .filter({ hasText: "Partial reply" });
            await expect(secondPagePartialResponse).toHaveCount(1);
            await expect(secondPagePartialResponse).toBeVisible();
            await expect(secondPage.getByText(linkedFile, { exact: true })).toBeVisible();
            await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
            await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("active-turn-secondary.png") });

            await secondPage.getByRole("button", { name: "Stop agent output", exact: true }).click();
            await expect(secondPage.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
            await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
            await expect(partialResponse).toHaveCount(1);
            await expect(secondPagePartialResponse).toHaveCount(1);
            await expect(partialResponse).toBeVisible();
            await expect(secondPagePartialResponse).toBeVisible();
            await secondPage.screenshot({ fullPage: true, path: testInfo.outputPath("completed-turn-secondary.png") });
        } finally {
            await secondPage.close();
        }
    });
});
