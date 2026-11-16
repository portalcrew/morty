import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
    MAX_PROMPT_ATTACHMENT_BYTES,
    PROMPT_IMAGE_MAX_BYTES,
    type PromptAttachment,
} from "@portalcrew/morty-client/protocol";
import type { PromptImageInput, PromptResourceInput } from "../../acp/client/prompt-content.ts";
import { OperationError } from "../../infra/operation-error.ts";

export class PromptArtifactError extends OperationError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "PromptArtifactError";
    }
}

export class ResolvedPromptArtifacts {
    readonly images: readonly PromptImageInput[];
    readonly resources: readonly PromptResourceInput[];
    constructor(images: readonly PromptImageInput[], resources: readonly PromptResourceInput[]) {
        this.images = images;
        this.resources = resources;
    }
}

interface ReadPromptArtifactResult {
    readonly bytes: Uint8Array;
    readonly path: string;
}

export type ReadPromptArtifact = (
    attachment: PromptAttachment,
    signal: AbortSignal,
) => Promise<ReadPromptArtifactResult>;

export function isTextPromptResourceMediaType(mediaType: string): boolean {
    return (
        mediaType.startsWith("text/") ||
        mediaType === "application/json" ||
        mediaType.endsWith("+json") ||
        mediaType === "application/xml" ||
        mediaType.endsWith("+xml")
    );
}

export async function resolvePromptArtifacts(
    read: ReadPromptArtifact,
    attachments: readonly PromptAttachment[],
    signal: AbortSignal,
): Promise<ResolvedPromptArtifacts> {
    const images: PromptImageInput[] = [];
    const resources: PromptResourceInput[] = [];
    for (const attachment of attachments) {
        signal.throwIfAborted();
        const artifact = await read(attachment, signal);
        const { bytes } = artifact;
        if (
            bytes.byteLength !== attachment.byteLength ||
            createHash("sha256").update(bytes).digest("hex") !== attachment.contentKey
        ) {
            throw new PromptArtifactError(
                "artifact_integrity_failed",
                "The prompt attachment failed integrity validation",
            );
        }
        if (attachment.kind === "image") {
            if (bytes.byteLength > PROMPT_IMAGE_MAX_BYTES || images.length >= 8) {
                continue;
            }
            images.push({
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
                name: attachment.name,
            });
            continue;
        }
        if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES || resources.length >= 16) {
            continue;
        }
        resources.push({
            mimeType: attachment.mimeType,
            name: attachment.name,
            type: "link",
            uri: pathToFileURL(artifact.path).href,
        });
    }
    return new ResolvedPromptArtifacts(images, resources);
}
