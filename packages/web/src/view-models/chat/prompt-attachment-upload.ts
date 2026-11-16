import type { MortyClient } from "@portalcrew/morty-client";
import type { NativeSessionTarget, PromptAttachment } from "@portalcrew/morty-client/protocol";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";

async function contentKey(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadPromptAttachment(
    sessions: MortyClient["sessions"],
    sessionTarget: NativeSessionTarget,
    attachment: ComposerAttachment,
    signal: AbortSignal,
): Promise<PromptAttachment> {
    signal.throwIfAborted();
    const key = await contentKey(attachment.bytes);
    signal.throwIfAborted();
    return await sessions.uploadContent(
        sessionTarget,
        {
            bytes: attachment.bytes,
            contentKey: key,
            kind: attachment.kind,
            mediaType: attachment.mediaType,
            name: attachment.name,
            uri: attachment.uri,
        },
        signal,
    );
}

export async function uploadPromptAttachments(
    sessions: MortyClient["sessions"],
    sessionTarget: NativeSessionTarget,
    attachments: readonly ComposerAttachment[],
    signal: AbortSignal,
): Promise<readonly PromptAttachment[]> {
    return await Promise.all(
        attachments.map((attachment) => uploadPromptAttachment(sessions, sessionTarget, attachment, signal)),
    );
}
