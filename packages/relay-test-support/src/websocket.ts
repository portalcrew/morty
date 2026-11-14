import type { Server } from "node:http";
import type { Duplex } from "node:stream";

export function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

export function port(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port");
    }
    return address.port;
}

export function sendText(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, "utf8");
    if (payload.byteLength > 65_535) {
        throw new Error("Test WebSocket message is too large");
    }
    const header =
        payload.byteLength < 126
            ? Buffer.from([0x81, payload.byteLength])
            : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
    socket.write(Buffer.concat([header, payload]));
}
