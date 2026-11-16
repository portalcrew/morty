export function readableAcpStream(
    input: NodeJS.ReadableStream,
    maximumBytes = Number.POSITIVE_INFINITY,
): ReadableStream<Uint8Array> {
    let streamOpen = true;
    let byteLength = 0;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!streamOpen) {
                    return;
                }
                if (!(chunk instanceof Uint8Array)) {
                    streamOpen = false;
                    controller.error(new Error("ACP process produced a non-binary chunk"));
                    return;
                }
                byteLength += chunk.byteLength;
                if (byteLength > maximumBytes) {
                    streamOpen = false;
                    controller.error(new Error("ACP adapter output limit exceeded"));
                    return;
                }
                controller.enqueue(new Uint8Array(chunk));
            });
            input.once("end", () => {
                if (streamOpen) {
                    streamOpen = false;
                    controller.close();
                }
            });
            input.once("error", (error) => {
                if (streamOpen) {
                    streamOpen = false;
                    controller.error(error);
                }
            });
        },
        cancel() {
            streamOpen = false;
        },
    });
}

export function createWritableAcpStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    let outputFailure: unknown;
    const pendingWriteFailures = new Set<(error: unknown) => void>();
    const fail = (error: unknown): void => {
        outputFailure = error;
        for (const reject of pendingWriteFailures) {
            reject(error);
        }
        pendingWriteFailures.clear();
    };
    output.on("error", fail);
    output.once("close", () => {
        if (outputFailure === undefined) {
            fail(new Error("ACP process input closed"));
        }
    });
    return new WritableStream<Uint8Array>({
        write(chunk) {
            if (outputFailure !== undefined) {
                return Promise.reject(outputFailure);
            }
            return new Promise<void>((resolve, reject) => {
                pendingWriteFailures.add(reject);
                output.write(chunk, (error) => {
                    pendingWriteFailures.delete(reject);
                    if (error) {
                        outputFailure = error;
                        reject(error);
                        return;
                    }
                    if (outputFailure !== undefined) {
                        reject(outputFailure);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}
