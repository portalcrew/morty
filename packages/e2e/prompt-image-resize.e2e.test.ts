import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { imagePreviewPng } from "../../tests/support/fake-daemon/image-preview.ts";
import { expect, test } from "./infra/test.ts";
import type { createTestRuntime } from "./infra/test-runtime.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Buffer): Buffer {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
}

function withMetadata(png: Buffer, byteLength: number): Buffer {
    const afterHeader = PNG_SIGNATURE.length + 25;
    return Buffer.concat([
        png.subarray(0, afterHeader),
        pngChunk("teXt", Buffer.alloc(byteLength, 0x61)),
        png.subarray(afterHeader),
    ]);
}

function detailedPng(width: number, height: number): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = randomBytes((width * 3 + 1) * height);
    for (let row = 0; row < height; row += 1) {
        rows[row * (width * 3 + 1)] = 0;
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(rows)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

async function sendAndReopen(runtime: Awaited<ReturnType<typeof createTestRuntime>>, image: Buffer) {
    const { page } = runtime;
    await runtime.openPairedChat();
    await page.getByRole("textbox", { name: "Message" }).fill("Describe this image");
    await page
        .getByLabel("Choose attachments")
        .setInputFiles({ name: "image.png", mimeType: "image/png", buffer: image });
    await expect(page.getByRole("button", { name: "View image: image.png" })).toBeVisible();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Codex turn 1: Describe this image")).toBeVisible();
    await page.reload();
    await page
        .getByRole("log", { name: "Messages" })
        .getByRole("button", { name: /^View image/u })
        .click();
    const viewer = page.getByRole("dialog", { name: "Image viewer" });
    await viewer.getByRole("button", { name: "Actual size" }).click();
    return viewer.getByRole("img");
}

test("Given a 4096 by 3072 photo larger than 5 MB, When the user sends it, Then the conversation keeps it at 2048 by 1536 after reload", async ({
    runtime,
}) => {
    const photo = withMetadata(imagePreviewPng(4096, 3072), 6_000_000);
    expect(photo.byteLength).toBeGreaterThan(5_000_000);
    const image = await sendAndReopen(runtime, photo);
    await expect(image).toHaveCSS("width", "2048px");
    await expect(image).toHaveCSS("height", "1536px");
});

test("Given a detailed 2048 by 1536 image too heavy for 2.5 MB at larger sizes, When the user sends it, Then the conversation keeps it at 768 by 576 after reload", async ({
    runtime,
}) => {
    const image = await sendAndReopen(runtime, detailedPng(2048, 1536));
    await expect(image).toHaveCSS("width", "768px");
    await expect(image).toHaveCSS("height", "576px");
});
