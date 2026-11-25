import { crc32 } from "node:zlib";
import { imagePreviewPng } from "../../tests/support/fake-daemon/image-preview.ts";
import { expect, test } from "./infra/test.ts";

function withMetadata(png: Buffer, byteLength: number): Buffer {
    const name = Buffer.from("teXt");
    const data = Buffer.alloc(byteLength, 0x61);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    const afterHeader = 8 + 25;
    return Buffer.concat([png.subarray(0, afterHeader), length, name, data, checksum, png.subarray(afterHeader)]);
}

test("Given a 4096 by 3072 photo larger than 5 MB, When the user sends it, Then the conversation keeps it at 2048 by 1536 after reload", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const photo = withMetadata(imagePreviewPng(4096, 3072), 6_000_000);
    expect(photo.byteLength).toBeGreaterThan(5_000_000);
    await page.getByRole("textbox", { name: "Message" }).fill("Describe this photo");
    await page
        .getByLabel("Choose attachments")
        .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
    await expect(page.getByRole("button", { name: "View image: photo.png" })).toBeVisible();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Codex turn 1: Describe this photo")).toBeVisible();
    await page.reload();
    const messages = page.getByRole("log", { name: "Messages" });
    await messages.getByRole("button", { name: /^View image/u }).click();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    await viewer.getByRole("button", { name: "Actual size" }).click();
    const image = viewer.getByRole("img");
    await expect(image).toHaveCSS("width", "2048px");
    await expect(image).toHaveCSS("height", "1536px");
});
