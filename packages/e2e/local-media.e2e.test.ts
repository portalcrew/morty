import { readFile } from "node:fs/promises";
import { expect, test } from "./infra/test.ts";

test("Given an agent links a video on the Computer, When the user opens it, Then it plays in the preview and downloads under its name", async ({
    runtime,
}) => {
    const { page } = runtime;
    const clip = new Uint8Array(await readFile(new URL("./fixtures/clip.webm", import.meta.url)));
    await runtime.openPairedChat();
    await runtime.writeFiles(new Map([["/workspace/clip.webm", { content: clip, mediaType: "video/webm" }]]));
    await page.getByRole("textbox", { name: "Message" }).fill("[Open clip](file:///workspace/clip.webm)");
    await page.getByRole("button", { name: "Send message" }).click();
    await page
        .getByRole("article", { name: "Agent response" })
        .getByRole("button", { name: "Open clip", exact: true })
        .click();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    const video = preview.getByLabel("clip.webm", { exact: true });
    await expect(video).toHaveJSProperty("videoWidth", 64);
    const downloadPromise = page.waitForEvent("download");
    await preview.getByRole("button", { name: "Download file" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("clip.webm");
    expect(new Uint8Array(await readFile(await download.path()))).toEqual(clip);
});
