import { expect, test } from "./infra/test.ts";

test("Given a completed reply with process work, When it renders, Then the turn keeps the documented vertical gaps", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    await page.getByRole("textbox", { name: "Message" }).fill("distinguish agent work");
    await page.getByRole("button", { name: "Send message" }).click();

    const userMessage = page.getByRole("article", { name: "Your message" });
    const reply = page.getByRole("article", { name: "Agent response" });
    const answer = reply.getByText("The requested update is complete.", { exact: true });
    const copy = page.getByRole("button", { name: "Copy response" });
    await expect(answer).toBeVisible();
    // The copy row only appears once the execution finished, so the follow
    // scroll has settled and bounding boxes are stable.
    await expect(copy).toBeVisible();

    const stepDisclosure = page.getByRole("button", { name: "1 step", exact: true });
    await expect(stepDisclosure).toBeVisible();
    if ((await stepDisclosure.getAttribute("aria-expanded")) === "true") {
        await stepDisclosure.click();
    }
    await page.mouse.move(0, 0);

    const answerItem = reply.locator('[data-testid="chat-agent-response"]');
    const [userBox, replyBox, stepBox, answerBox, copyBox] = await Promise.all([
        userMessage.boundingBox(),
        reply.boundingBox(),
        stepDisclosure.boundingBox(),
        answerItem.boundingBox(),
        copy.boundingBox(),
    ]);
    if (userBox === null || replyBox === null || stepBox === null || answerBox === null || copyBox === null) {
        throw new Error("Expected every measured turn element to have a layout box");
    }
    expect(replyBox.y - (userBox.y + userBox.height)).toBeCloseTo(42, 5);
    expect(answerBox.y - (stepBox.y + stepBox.height)).toBeCloseTo(12, 5);
    expect(copyBox.y - (answerBox.y + answerBox.height)).toBeCloseTo(12, 5);

    await stepDisclosure.click();
    const reasoningRow = page.locator("summary").filter({ hasText: "Show Thinking" });
    await expect(reasoningRow).toBeVisible();
    await reasoningRow.click();
    const reasoningText = page.getByRole("group", { name: "Agent thinking" }).locator("pre");
    await expect(reasoningText).toBeVisible();
    const reasoningStyle = await reasoningText.evaluate((element) => {
        const style = getComputedStyle(element);
        return { fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    expect(reasoningStyle).toEqual({ fontSize: "12px", lineHeight: "20px" });

    await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("agent-reply-spacing.png"),
    });
});

test("Given markdown in an agent answer, When it renders, Then headings, paragraphs, lists, quotes, code, and tables follow the documented typography", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();

    const prompt = [
        "Spacing probe",
        "",
        "# Top heading",
        "",
        "First paragraph with `inline` code.",
        "",
        "Second paragraph.",
        "",
        "## Sub heading",
        "",
        "### Section heading",
        "",
        "- alpha",
        "- beta",
        "",
        "> quoted line",
        "",
        "| Col A | Col B |",
        "| --- | --- |",
        "| one | two |",
    ].join("\n");
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();

    const reply = page.getByRole("article", { name: "Agent response" });
    await expect(reply.getByRole("heading", { level: 1, name: "Top heading" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy response" })).toBeVisible();

    // Measure everything in one pass so scrolling cannot skew the gaps.
    const metrics = await reply.evaluate((replyNode) => {
        const element = (selector: string): Element => {
            const node = replyNode.querySelector(selector);
            if (node === null) {
                throw new Error(`Expected ${selector} inside the agent reply`);
            }
            return node;
        };
        const paragraphContaining = (text: string): Element => {
            for (const candidate of replyNode.querySelectorAll("p")) {
                if ((candidate.textContent ?? "").includes(text)) {
                    return candidate;
                }
            }
            throw new Error(`Expected a paragraph containing "${text}"`);
        };
        const typography = (node: Element) => {
            const style = getComputedStyle(node);
            return {
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                marginBottom: style.marginBottom,
                marginTop: style.marginTop,
            };
        };
        const listItems = [...replyNode.querySelectorAll("li")];
        const [firstItem, secondItem] = listItems;
        if (firstItem === undefined || secondItem === undefined) {
            throw new Error("Expected at least two rendered list items");
        }
        const firstParagraph = paragraphContaining("First paragraph").getBoundingClientRect();
        const secondParagraph = paragraphContaining("Second paragraph").getBoundingClientRect();
        const quote = getComputedStyle(element("blockquote"));
        const headerCell = getComputedStyle(element("th"));
        const headingGap =
            element("h1").getBoundingClientRect().top -
            paragraphContaining("Spacing probe").getBoundingClientRect().bottom;
        return {
            h1: typography(element("h1")),
            h1Gap: headingGap,
            h2: typography(element("h2")),
            h3: typography(element("h3")),
            inlineCodeFontSize: getComputedStyle(element("code")).fontSize,
            listItemGap: secondItem.getBoundingClientRect().top - firstItem.getBoundingClientRect().bottom,
            paragraph: typography(paragraphContaining("First paragraph")),
            paragraphGap: secondParagraph.top - firstParagraph.bottom,
            blockquote: {
                borderLeftWidth: quote.borderLeftWidth,
                fontStyle: quote.fontStyle,
                marginTop: quote.marginTop,
                paddingTop: quote.paddingTop,
            },
            tableHeader: {
                fontSize: headerCell.fontSize,
                paddingLeft: headerCell.paddingLeft,
                paddingTop: headerCell.paddingTop,
            },
        };
    });

    expect(metrics.h1).toEqual({
        fontSize: "24px",
        fontWeight: "600",
        lineHeight: "30px",
        marginBottom: "20px",
        marginTop: "40px",
    });
    expect(metrics.h1Gap).toBeCloseTo(40, 5);
    expect(metrics.h2).toEqual({
        fontSize: "20px",
        fontWeight: "600",
        lineHeight: "26px",
        marginBottom: "16px",
        marginTop: "32px",
    });
    expect(metrics.h3).toEqual({
        fontSize: "16px",
        fontWeight: "600",
        lineHeight: "24px",
        marginBottom: "12px",
        marginTop: "24px",
    });
    expect(metrics.paragraph).toMatchObject({ fontSize: "14px", lineHeight: "24px" });
    // Adjacent 8px paragraph margins collapse to a single 8px gap.
    expect(metrics.paragraphGap).toBeCloseTo(8, 5);
    expect(metrics.listItemGap).toBeCloseTo(6, 5);
    expect(metrics.inlineCodeFontSize).toBe("12px");
    expect(metrics.blockquote).toEqual({
        borderLeftWidth: "3px",
        fontStyle: "normal",
        marginTop: "16px",
        paddingTop: "8px",
    });
    expect(metrics.tableHeader).toEqual({ fontSize: "13px", paddingLeft: "10px", paddingTop: "10px" });

    await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath("agent-markdown-typography.png"),
    });
});
