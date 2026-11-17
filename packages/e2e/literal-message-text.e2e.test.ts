import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
]) {
    test(`Given code-like prose at ${viewport.width}px, When I send it and reload, Then the conversation preserves angle brackets`, async ({
        runtime,
    }, testInfo) => {
        const { page } = runtime;
        await page.setViewportSize(viewport);
        await runtime.openPairedChat();
        const prompt = "Compare Vec<String> and Option<T>. Mention <placeholder> and <div>x</div> literally.";
        await page.getByRole("textbox", { name: "Message" }).fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const userMessage = page.getByTestId(dataTestId.userMessage).first();
        const response = page.getByRole("article", { name: "Agent response" });
        await expect(userMessage).toContainText(prompt);
        await expect(response).toContainText(prompt);
        await page.reload();
        await expect(userMessage).toContainText(prompt);
        await expect(response).toContainText(prompt);
        if (viewport.width < 640) {
            await page.getByRole("button", { name: "Expand message composer" }).click();
        }
        await page.getByRole("textbox", { name: "Message" }).fill("hold after first delta");
        await page.getByRole("button", { name: "Send message" }).click();
        const messages = page.getByRole("log", { name: "Messages" });
        await expect(messages).toContainText("Partial reply");
        const stop = page.getByRole("button", { name: "Stop agent output", exact: true });
        await expect(stop).toBeVisible();
        await runtime.continueReply("hold after first delta", {
            outcome: "hold",
            output: [{ kind: "text", text: "\n\nUse Vec<Str" }],
        });
        await expect(messages).toContainText("Use Vec<Str");
        await runtime.continueReply("hold after first delta", {
            outcome: "hold",
            output: [{ kind: "text", text: "ing> and <placeholder" }],
        });
        await expect(messages).toContainText("Use Vec<String> and <placeholder");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`literal-streaming-${viewport.width}.png`),
        });
        await runtime.continueReply("hold after first delta", {
            outcome: "complete",
            output: [{ kind: "text", text: "> literally." }],
        });
        await expect(messages).toContainText("Use Vec<String> and <placeholder> literally.");
        await expect(stop).toBeHidden();
        await page.reload();
        await expect(messages).toContainText("Use Vec<String> and <placeholder> literally.");
        await page.screenshot({
            animations: "disabled",
            path: testInfo.outputPath(`literal-message-${viewport.width}.png`),
        });
    });
}
