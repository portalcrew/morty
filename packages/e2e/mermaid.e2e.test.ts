import { expect, test } from "./infra/test.ts";

test("Given a paired Bot, When a Mermaid reply finishes, Then I see a Morty-themed diagram that I can copy and enlarge", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a deployment diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Browser" });
    await expect(response).toContainText("Browser --> Worker");
    await expect(response.getByRole("img", { name: "Mermaid chart", exact: true })).toHaveCount(0);

    await runtime.continueReply("draw a deployment diagram", {
        outcome: "complete",
        output: [],
    });
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("Worker");
    await expect(diagram).toContainText("Agent");
    await expect(diagram.getByText("Browser", { exact: true })).toHaveCSS("font-family", /Inter/);
    await expect(diagram.getByText("Browser", { exact: true })).toHaveCSS("fill", "rgb(14, 15, 17)");
    await expect(diagram).toHaveCSS("background-color", "rgb(247, 248, 249)");
    await expect(diagram.getByText("Browser", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(diagram.getByText("Worker", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(diagram.getByText("Agent", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-streamed.png"), fullPage: true });

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Worker --> Agent");
    await response.getByRole("button", { name: "View diagram fullscreen", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Browser", { exact: true })).toHaveCSS("fill", "rgb(14, 15, 17)");
    await expect(page.getByRole("dialog").getByText("Worker", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-fullscreen.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(diagram).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(diagram).toBeVisible();
    await expect(diagram.getByText("Browser", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("mermaid-mobile.png"), fullPage: true });
});

test("Given a finished Mermaid diagram in a long reply, When I scroll the conversation with the wheel over it, Then the conversation scrolls and the diagram keeps its size", async ({
    runtime,
}) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 1280, height: 720 });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a sequence diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Request sequence." });
    await runtime.continueReply("draw a sequence diagram", {
        outcome: "complete",
        output: [
            {
                kind: "text",
                text: Array.from({ length: 30 }, (_, index) => `\n\nFollow-up note ${(index + 1).toString()}.`).join(
                    "",
                ),
            },
        ],
    });
    await expect(response).toContainText("Follow-up note 30.");
    // The diagram renders once it nears the viewport; its source disclosure is always present.
    await response.getByText("View diagram source", { exact: true }).scrollIntoViewIfNeeded();
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toContainText("Send request");
    const messages = page.getByRole("log", { name: "Messages" });
    const before = await diagram.boundingBox();
    const scrollBefore = await messages.evaluate((node) => node.scrollTop);
    expect(before).not.toBeNull();

    await page.mouse.move((before?.x ?? 0) + (before?.width ?? 0) / 2, (before?.y ?? 0) + (before?.height ?? 0) / 2);
    await page.mouse.wheel(0, 300);

    await expect.poll(() => messages.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollBefore + 200);
    const after = await diagram.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
});

test("Given a wide Mermaid diagram on a phone viewport, When I open it fullscreen, Then it opens legible and I can pan it", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a wide deployment diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Morty chat UI" });
    await expect(response).toContainText("model backend");
    await runtime.continueReply("draw a wide deployment diagram", {
        outcome: "complete",
        output: [],
    });
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });

    await response.getByRole("button", { name: "View diagram fullscreen", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const chart = dialog.getByRole("img", { name: "Mermaid chart" });
    await expect(chart).toBeVisible();
    // The diagram is wider than the phone. It opens at a readable scale that
    // uses the viewport width instead of shrinking to a fraction of it.
    const chartBox = await chart.boundingBox();
    expect(chartBox?.width ?? 0).toBeGreaterThan(390);
    const labelBox = await dialog.getByText("Browser", { exact: true }).first().boundingBox();
    expect(labelBox?.height ?? 0).toBeGreaterThan(10);
    await page.screenshot({ path: testInfo.outputPath("mermaid-fullscreen-mobile.png"), fullPage: true });

    // The unreadable part of the graph is reachable by panning.
    await page.mouse.move(195, 422);
    await page.mouse.down();
    await page.mouse.move(315, 422, { steps: 5 });
    await page.mouse.up();
    const pannedBox = await chart.boundingBox();
    expect(Math.round((pannedBox?.x ?? 0) - (chartBox?.x ?? 0))).toBeGreaterThan(100);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Given a live reply with a closed Mermaid fence, When I read the response, Then the sequence diagram is visible before the turn ends", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("draw a sequence diagram");
    await page.getByRole("button", { name: "Send message" }).click();
    const response = page.getByRole("article", { name: "Agent response" }).filter({ hasText: "Request sequence." });
    const diagram = response.getByRole("img", { name: "Mermaid chart", exact: true });
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("Send request");
    await expect(diagram.getByText("Send request", { exact: true })).toHaveCSS("fill", "rgb(14, 15, 17)");
    await expect(diagram.getByText("Send request", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeVisible();
    await response.getByText("View diagram source", { exact: true }).click();
    await expect(response.getByText("Client->>Server: Send request", { exact: false }).last()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mermaid-sequence.png"), fullPage: true });
    await runtime.continueReply("draw a sequence diagram", { outcome: "complete", output: [] });
    await expect(page.getByRole("button", { name: "Stop agent output", exact: true })).toBeHidden();
    await expect(diagram).toBeVisible();
});
