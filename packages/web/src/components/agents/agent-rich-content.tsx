import { ExternalLink, FileText, Image as ImageIcon, Terminal, Video } from "lucide-react";
import type { AgentDisplayContent } from "../../components/agents/display-content.ts";
import { ToolTextPreview } from "../chat/tool-text-preview.tsx";
import { ImageGallery, PreviewImage } from "../images/image-gallery.tsx";
import type { MarkdownImageReader } from "./agent-markdown.tsx";
import { AgentMarkdown } from "./agent-markdown.tsx";
import { SessionResource } from "./session-resource.tsx";

const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;
const VIDEO_CONTENT_MIME = /^video\//;

function safeLink(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

function displayLabel(content: AgentDisplayContent): string {
    switch (content.type) {
        case "text":
            return content.type;
        case "image":
            return content.name || content.uri || content.type;
        case "resource":
            return content.name || content.uri || content.type;
        case "resource_link":
            return content.name || content.uri || content.type;
        case "diff":
            return content.path || content.type;
        case "terminal":
            return content.terminalId.length > 0 ? content.terminalId : content.type;
    }
}

function displayKey(content: AgentDisplayContent, index: number): string {
    const identity =
        content.type === "text"
            ? ""
            : content.type === "diff"
              ? content.path
              : content.type === "terminal"
                ? content.terminalId
                : `${content.name}:${content.uri}`;
    return `${content.type}:${identity}:${index.toString()}`;
}

function isVideoResource(content: Extract<AgentDisplayContent, { readonly type: "resource" }>): boolean {
    return VIDEO_CONTENT_MIME.test(content.mimeType);
}

type ImageContent = Extract<AgentDisplayContent, { readonly type: "image" }>;

function ContentHeader({ content }: { readonly content: AgentDisplayContent }) {
    const label = displayLabel(content);
    const media =
        content.type === "terminal"
            ? "terminal"
            : content.type === "image"
              ? "image"
              : content.type === "resource" && isVideoResource(content)
                ? "video"
                : "file";
    return (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.04em] text-[#7d8590] uppercase">
            {media === "image" ? (
                <ImageIcon className="size-3" />
            ) : media === "video" ? (
                <Video className="size-3" />
            ) : media === "terminal" ? (
                <Terminal className="size-3" />
            ) : (
                <FileText className="size-3" />
            )}
            <span className="truncate normal-case tracking-normal" title={label}>
                {label}
            </span>
        </div>
    );
}

function LocalImage({
    content,
    readImage,
}: {
    readonly content: ImageContent;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    return (
        <SessionResource request={{ kind: "raster-image", path: content.uri }} read={readImage}>
            {(state) => {
                if (state.kind === "loading") {
                    return (
                        <div className="min-h-24 rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                            Loading media…
                        </div>
                    );
                }
                if (state.kind !== "media") {
                    return (
                        <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                            Media content could not be loaded.
                        </div>
                    );
                }
                return (
                    <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
                        <ContentHeader content={content} />
                        <PreviewImage
                            alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                            className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                            loading="lazy"
                            blob={state.blob}
                            src={state.source}
                        />
                    </figure>
                );
            }}
        </SessionResource>
    );
}

function AgentRichContentItem({
    content,
    readImage,
}: {
    readonly content: AgentDisplayContent;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    if (content.type === "image" && content.uri.length > 0) {
        if (readImage !== undefined) {
            return <LocalImage content={content} readImage={readImage} />;
        }
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                Media content could not be loaded.
            </div>
        );
    }
    if (content.type === "image") {
        if (!SAFE_IMAGE_MIME.test(content.mimeType) || content.data.length === 0) {
            return (
                <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                    Media content could not be displayed safely.
                </div>
            );
        }
        return (
            <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
                <ContentHeader content={content} />
                <PreviewImage
                    alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                    className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                    loading="lazy"
                    src={`data:${content.mimeType};base64,${content.data}`}
                />
            </figure>
        );
    }
    if (content.type === "diff") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white">
                <div className="border-b-[0.5px] border-black/7 px-3 pt-2">
                    <ContentHeader content={content} />
                </div>
                <div className="grid font-mono text-[11px] leading-[18px] md:grid-cols-2">
                    <ToolTextPreview
                        className="max-h-none rounded-none bg-[#fff4f2] p-3 text-[#8f2f35]"
                        text={content.oldText}
                    />
                    <ToolTextPreview
                        className="max-h-none rounded-none bg-[#effaf4] p-3 text-[#17663f]"
                        text={content.newText}
                    />
                </div>
            </section>
        );
    }
    if (content.type === "resource_link") {
        const href = safeLink(content.uri);
        return (
            <div className="rounded-lg border-[0.5px] border-black/9 bg-white p-3">
                <ContentHeader content={content} />
                {href.length > 0 ? (
                    <a
                        className="inline-flex min-h-11 items-center gap-1.5 break-all text-xs font-medium text-primary transition-colors duration-150 hover:text-primary-hover active:text-primary-active motion-reduce:transition-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70 md:min-h-9"
                        href={href}
                        rel="noreferrer"
                        target="_blank"
                    >
                        {content.text.length > 0 ? content.text : href}
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                ) : (
                    <code className="break-all text-[11px] text-muted-foreground">{content.uri}</code>
                )}
            </div>
        );
    }
    if (content.type === "terminal") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-[#17191d] text-[#e6e8eb]">
                <div className="px-3 pt-2 text-[#aeb5bc]">
                    <ContentHeader content={content} />
                </div>
                <ToolTextPreview
                    className="bg-transparent px-3 pb-3 font-mono text-[11px] leading-[18px]"
                    text={content.terminalId}
                />
            </section>
        );
    }
    if (content.type === "text") {
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-white px-3 py-2">
                <AgentMarkdown markdown={content.text} streaming={false} />
            </div>
        );
    }
    return (
        <section className="rounded-xl border-[0.5px] border-black/9 bg-white p-3">
            <ContentHeader content={content} />
            {content.text.length > 0 && (
                <ToolTextPreview
                    className="bg-transparent p-0 font-mono text-[11px] leading-[18px] text-[#555c68]"
                    text={content.text}
                />
            )}
            {content.uri.length > 0 && (
                <code className="mt-2 block break-all text-[10px] text-muted-foreground">{content.uri}</code>
            )}
        </section>
    );
}

export function AgentRichContent({
    contents,
    readImage,
}: {
    readonly contents: readonly AgentDisplayContent[];
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    if (contents.length === 0) {
        return null;
    }
    return (
        <ImageGallery>
            <div className="mt-2 grid gap-2">
                {contents.map((content, index) => (
                    <AgentRichContentItem content={content} key={displayKey(content, index)} readImage={readImage} />
                ))}
            </div>
        </ImageGallery>
    );
}
