import { externalContentPath, type MortyExternalContentBlock } from "@morty-build/client";
import { type ReactNode, useMemo } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { PreviewImage, UserImagePlaceholder } from "../images/image-gallery.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { textLinkClassName } from "../ui/text-link.ts";
import type { MarkdownImageReader } from "./agent-markdown.tsx";
import { isDisplayableImageType } from "./displayable-image-type.ts";
import type { SessionResourceRequest, SessionResourceState } from "./resource-reader.ts";
import { SessionResource } from "./session-resource.tsx";

const SAFE_AUDIO_MIME = /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u;

export function LinkedResourceBlock({
    mediaType,
    name,
    path,
    readContent,
    speaker,
}: {
    readonly mediaType: string;
    readonly name: string;
    readonly path: string;
    readonly readContent?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    const request = useMemo<SessionResourceRequest>(
        () => ({ path, kind: mediaType === "image/svg+xml" ? "image" : "download", mediaType }),
        [mediaType, path],
    );
    return (
        <SessionResource inline request={request} read={readContent}>
            {(state) => {
                if (state.kind === "loading") {
                    return speaker === "user" && mediaType === "image/svg+xml" ? (
                        <UserImagePlaceholder />
                    ) : (
                        <p className="text-sm text-muted-foreground">Loading content…</p>
                    );
                }
                if (state.kind !== "media") {
                    return <p className="text-sm text-muted-foreground">Content could not be loaded: {name}</p>;
                }
                return mediaType === "image/svg+xml" ? (
                    <PreviewImage
                        alt={speaker === "user" ? "Your attachment" : "Agent-provided content"}
                        className={
                            speaker === "user"
                                ? "size-[120px] max-w-full shrink-0 rounded-[12px] object-cover"
                                : "max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                        }
                        data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                        blob={state.blob}
                        insetStroke={speaker === "user"}
                        src={state.source}
                    />
                ) : (
                    <a className="break-all text-sm underline" download={name} href={state.source}>
                        Download {name}
                    </a>
                );
            }}
        </SessionResource>
    );
}

/**
 * Renders a Session's external content block through the injected reader and
 * the shared session-resource store: the store owns loading, cancellation,
 * and the object URL's lifetime through the ref-cleanup protocol, so this
 * component only maps resource state to presentation.
 */
export function ExternalContentBlock({
    content,
    readContent,
    speaker,
}: {
    readonly content: MortyExternalContentBlock;
    readonly readContent?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    const request = useMemo<SessionResourceRequest>(
        () => ({ path: externalContentPath(content), kind: requestKind(content) }),
        [content],
    );
    return (
        <SessionResource inline request={request} read={readContent}>
            {(state) => renderContent(content, state, speaker)}
        </SessionResource>
    );
}

function requestKind(content: MortyExternalContentBlock): SessionResourceRequest["kind"] {
    if (content.type === "external_resource" && content.mimeType === "image/svg+xml") {
        return "image";
    }
    if (content.type === "external_resource" && content.encoding === "text") {
        return "text";
    }
    if (content.type === "external_image") {
        return "image";
    }
    if (content.type === "external_audio") {
        return "audio";
    }
    return "download";
}

function renderContent(
    content: MortyExternalContentBlock,
    state: SessionResourceState,
    speaker: "assistant" | "user",
): ReactNode {
    if (state.kind === "loading") {
        return speaker === "user" &&
            (content.type === "external_image" ||
                (content.type === "external_resource" && content.mimeType === "image/svg+xml")) ? (
            <UserImagePlaceholder />
        ) : (
            <p className="text-sm text-muted-foreground">Loading content…</p>
        );
    }
    if (state.kind === "failed") {
        return <p className="text-sm text-muted-foreground">Content could not be loaded.</p>;
    }
    switch (content.type) {
        case "external_image":
            return isDisplayableImageType(content.mimeType) && state.kind === "media" ? (
                <PreviewImage
                    alt={speaker === "user" ? "Your attachment" : "Agent-provided content"}
                    className={
                        speaker === "user"
                            ? "size-[120px] max-w-full shrink-0 rounded-[12px] object-cover"
                            : "max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                    }
                    data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                    blob={state.blob}
                    insetStroke={speaker === "user"}
                    src={state.source}
                />
            ) : (
                <p className="text-sm text-muted-foreground">Image content could not be displayed safely.</p>
            );
        case "external_audio":
            return SAFE_AUDIO_MIME.test(content.mimeType) && state.kind === "media" ? (
                <audio controls src={state.source}>
                    <track kind="captions" />
                </audio>
            ) : (
                <p className="text-sm text-muted-foreground">Audio content could not be displayed safely.</p>
            );
        case "external_resource":
            return content.mimeType === "image/svg+xml" && state.kind === "media" ? (
                <PreviewImage
                    alt={speaker === "user" ? "Your attachment" : "Agent-provided content"}
                    className={
                        speaker === "user"
                            ? "size-[120px] max-w-full shrink-0 rounded-[12px] object-cover"
                            : "max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                    }
                    data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                    blob={state.blob}
                    insetStroke={speaker === "user"}
                    src={state.source}
                />
            ) : content.encoding === "text" && state.kind === "text" ? (
                <ScrollArea
                    className="max-h-96 rounded-lg bg-muted"
                    orientation="both"
                    viewportClassName="max-h-[inherit] p-3"
                >
                    <pre className="whitespace-pre-wrap text-xs">{state.text}</pre>
                </ScrollArea>
            ) : state.kind === "media" ? (
                <a className={cn("break-all text-sm", textLinkClassName)} download href={state.source}>
                    Download resource
                </a>
            ) : (
                <p className="text-sm text-muted-foreground">Content could not be loaded.</p>
            );
    }
}
