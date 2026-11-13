import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { UserMessageShell } from "../../components/chat/user-message-shell.tsx";
import { dataTestId } from "../../data-testid.ts";
import { AgentMarkdown } from "../agents/agent-markdown.tsx";
import { createFileSource } from "../images/file-source.ts";
import { ImageGallery, PreviewImage, UserImagePlaceholder } from "../images/image-gallery.tsx";
import type { ComposerAttachment } from "./composer-attachment.ts";

interface UserPromptMessageProps {
    readonly attachments: readonly ComposerAttachment[];
    readonly text: string;
    readonly attachmentLabels?: readonly { readonly name: string; readonly uri: string }[];
    /** Shown beside the bubble, such as the message's delivery state. */
    readonly status?: ReactNode;
}

function PromptImage({ attachment }: { readonly attachment: ComposerAttachment }) {
    const [source, setSource] = useState("");
    useEffect(() => {
        const file = createFileSource(attachment.bytes, attachment.mediaType);
        setSource(file.source);
        return file.release;
    }, [attachment]);
    return source.length === 0 ? (
        <UserImagePlaceholder />
    ) : (
        <PreviewImage
            alt={attachment.name}
            className="size-[120px] max-w-full shrink-0 rounded-[12px] object-cover"
            insetStroke
            loading="lazy"
            src={source}
        />
    );
}

export function UserPromptMessage({ attachments, attachmentLabels = [], status, text }: UserPromptMessageProps) {
    if (text.length === 0 && attachments.length === 0 && attachmentLabels.length === 0) {
        return null;
    }
    const images = attachments.filter((attachment) => attachment.kind === "image");
    const resources = attachments.filter((attachment) => attachment.kind === "resource");
    return (
        <ImageGallery>
            <UserMessageShell>
                {images.length > 0 && (
                    <div className={cn("relative ml-auto grid min-w-0 gap-1.5", images.length > 1 && "grid-cols-2")}>
                        {images.map((image, index) => (
                            <PromptImage attachment={image} key={`${index.toString()}:${image.name}`} />
                        ))}
                        {text.length === 0 &&
                            resources.length === 0 &&
                            attachmentLabels.length === 0 &&
                            status !== undefined && (
                                <span className="absolute top-1/2 right-full mr-1.5 flex -translate-y-1/2">
                                    {status}
                                </span>
                            )}
                    </div>
                )}
                {(text.length > 0 || resources.length > 0 || attachmentLabels.length > 0) && (
                    <MessageBubble copyText={text} data-testid={dataTestId.userMessage} speaker="user" status={status}>
                        <div className="grid min-w-0 gap-2">
                            {(resources.length > 0 || attachmentLabels.length > 0) && (
                                <div className="flex flex-wrap gap-1.5">
                                    {[...resources, ...attachmentLabels].map(({ name, uri }) => (
                                        <span
                                            className="rounded-md border border-black/[0.06] bg-muted/40 px-2 py-1 font-mono text-[10px]"
                                            key={`${uri}:${name}`}
                                        >
                                            {name}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {text.length > 0 && <AgentMarkdown markdown={text} streaming={false} />}
                        </div>
                    </MessageBubble>
                )}
            </UserMessageShell>
        </ImageGallery>
    );
}
