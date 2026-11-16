import { z } from "zod";
import type { ThreadItem } from "./app-server-protocol.ts";
import type { CodexMessageUpdate } from "./session-update.ts";

const textInput = z.object({ type: z.literal("text"), text: z.string() });
const imageInput = z.object({ type: z.literal("image"), url: z.string() });

export function userMessageUpdates(
    item: Extract<ThreadItem, { readonly type: "userMessage" }>,
    submitted?: readonly ContentBlock[],
): readonly CodexMessageUpdate[] {
    if (submitted !== undefined) {
        return submitted.map((content) => ({ sessionUpdate: "user_message_chunk", messageId: item.id, content }));
    }
    return item.content.flatMap((input): CodexMessageUpdate[] => {
        const text = textInput.safeParse(input);
        if (text.success) {
            return [
                {
                    sessionUpdate: "user_message_chunk",
                    messageId: item.id,
                    content: { type: "text", text: text.data.text },
                },
            ];
        }
        const image = imageInput.safeParse(input);
        if (image.success) {
            const data = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(image.data.url);
            return [
                {
                    sessionUpdate: "user_message_chunk",
                    messageId: item.id,
                    content: {
                        type: "image",
                        data: data?.[2] ?? "",
                        mimeType: data?.[1] ?? "image/png",
                        ...(data === null ? { uri: image.data.url } : {}),
                    },
                },
            ];
        }
        return [];
    });
}

import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
