import { crc32, deflateSync } from "node:zlib";

export function imagePreviewPng(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer): Buffer => {
        const name = Buffer.from(type);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
        return Buffer.concat([length, name, data, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const pixels = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * (width * 3 + 1) + 1 + x * 3;
            pixels[offset] = Math.floor(y / 120) % 2 === 0 ? 42 : 235;
            pixels[offset + 1] = Math.floor(x / 120) % 2 === 0 ? 130 : 210;
            pixels[offset + 2] = 180;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
