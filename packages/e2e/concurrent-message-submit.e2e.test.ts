import { expect, test } from "./infra/test.ts";

test("Given two devices share an idle conversation, When both send a draft, Then both messages run without losing text or attachments", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await page.setViewportSize({ width: 1440, height: 900 });
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("Open a shared conversation");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("article", { name: "Agent response" })).toContainText("Open a shared conversation");
    const secondPage = await page.context().newPage();
    try {
        await secondPage.setViewportSize({ width: 390, height: 844 });
        await secondPage.goto(page.url());
        const participants = [
            { page, prompt: "hold after first delta", fileName: "first.json" },
            { page: secondPage, prompt: "wait for steering", fileName: "second.json" },
        ];
        for (const participant of participants) {
            await participant.page.getByRole("textbox", { name: "Message" }).fill(participant.prompt);
            await participant.page.getByLabel("Choose attachments").setInputFiles({
                name: participant.fileName,
                mimeType: "text/plain",
                buffer: Buffer.from(`Attachment contents for ${participant.fileName}`),
            });
            await expect(participant.page.getByRole("list", { name: "Attachments" })).toContainText(
                participant.fileName,
            );
        }
        await Promise.all(
            participants.map(async (participant) => {
                await participant.page.getByRole("button", { name: "Send message" }).click();
            }),
        );
        const queue = page.getByLabel("Queued messages", { exact: true });
        await expect(queue).toBeVisible();
        for (const participant of participants) {
            await expect(participant.page.getByRole("textbox", { name: "Message" })).toHaveValue("");
            await expect(participant.page.getByRole("list", { name: "Attachments" })).toBeHidden();
        }
        await page.getByRole("button", { name: "Stop agent output" }).click();
        await expect(queue).toBeHidden();
        await expect(page.getByRole("log", { name: "Messages" })).toContainText("Partial reply");
        await expect(page.getByRole("log", { name: "Messages" })).toContainText("Waiting for steering");
        await page.getByRole("button", { name: "Stop agent output" }).click();
        await expect(page.getByRole("button", { name: "Stop agent output" })).toBeHidden();
        await secondPage.reload();
        for (const participant of participants) {
            await expect(secondPage.getByRole("log", { name: "Messages" })).toContainText(participant.prompt);
            await expect(secondPage.getByRole("log", { name: "Messages" })).toContainText(
                `Download ${participant.fileName}`,
            );
        }
        await secondPage.screenshot({
            animations: "disabled",
            path: testInfo.outputPath("concurrent-messages-after-reload.png"),
        });
    } finally {
        await secondPage.close();
    }
});
