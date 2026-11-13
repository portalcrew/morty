import {
    FILE_FAILED_KIND,
    type FILE_READ_KIND,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { streamLocalFile } from "../../../../session/content/session-files.ts";
import type { CommandHandler } from "../../definition.ts";
import { send, sendContentChunk } from "../../transport.ts";

export const handleFileRead: CommandHandler<typeof FILE_READ_KIND> = (context, message): Promise<void> => {
    const { externalContent, sessions, signal, socket, payloadEncryption } = context;
    return streamLocalFile({
        command: message,
        sendBegin: async (response) =>
            send(socket, await fileBeginEventCodec.encode(response, payloadEncryption, signal)),
        sendEnd: async (response) => send(socket, await fileEndEventCodec.encode(response, payloadEncryption, signal)),
        sendChunk: async (requestId, sequence, bytes) =>
            await sendContentChunk(context, requestId, sequence, bytes, signal),
        signal,
        workingDirectory: sessions.findSessions([message.target])[0]?.cwd ?? null,
        externalContent,
    }).catch(async (error: unknown) => {
        if (socket.readyState !== WebSocket.OPEN || signal.aborted) {
            return;
        }
        const encoded = await fileFailedEventCodec.encode(
            {
                code: "file_unavailable",
                kind: FILE_FAILED_KIND,
                message: error instanceof Error ? error.message : "The local file is unavailable",
                requestId: message.requestId,
                target: message.target,
            },
            payloadEncryption,
            signal,
        );
        if (socket.readyState === WebSocket.OPEN) {
            send(socket, encoded);
        }
    });
};
