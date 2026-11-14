import { Check, Copy, Download, ImageIcon, Maximize2 } from "lucide-react";
import { Lexer } from "marked";
import {
    defaultRehypePlugins,
    defaultRemarkPlugins,
    type MathPlugin,
    parseMarkdownIntoBlocks,
    Streamdown,
} from "streamdown";
import { ImageGallery, PreviewImage } from "../images/image-gallery.tsx";
import "streamdown/styles.css";
import { type ComponentProps, createContext, type SVGProps, useContext, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import { boundedCodeHighlighter } from "../../components/agents/bounded-code-highlighter.ts";
import { MermaidCodeBlock } from "../../components/agents/mermaid-code-block.tsx";
import { remarkMermaidCompletion } from "../../components/agents/remark-mermaid-completion.ts";
import { textLinkClassName } from "../ui/text-link.ts";
import { RemoteImageConsent, type RemoteImageConsentModel } from "./remote-image-consent.tsx";
import type { SessionResourceReader as MarkdownImageReader } from "./resource-reader.ts";
import { SessionResource } from "./session-resource.tsx";

export type { SessionResourceReader as MarkdownImageReader } from "./resource-reader.ts";

const STREAMDOWN_CONTROLS = Object.freeze({
    code: Object.freeze({ copy: false, download: false }),
    table: Object.freeze({ copy: false }),
});
const STREAMDOWN_PLUGINS = Object.freeze({
    code: boundedCodeHighlighter,
    renderers: [{ language: "mermaid", component: MermaidCodeBlock }],
});
const STREAMDOWN_TRANSLATIONS = Object.freeze({ copyCode: "Copy code" });
// Tags render as literal text, so incomplete tags must remain visible while streaming.
const STREAMDOWN_REMEND = Object.freeze({ htmlTags: false });
// Without the raw-HTML parser, Streamdown preserves HTML nodes as literal text.
// Keep sanitization and URL hardening for the elements produced by Markdown.
const STREAMDOWN_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "raw")
    .map(([, plugin]) => plugin);

type StreamdownIconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function StreamdownCopyIcon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Copy aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

function StreamdownCheckIcon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Check aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

function StreamdownDownloadIcon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Download aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

function StreamdownMaximize2Icon({ className, size: _size, ...props }: StreamdownIconProps) {
    return <Maximize2 aria-hidden="true" className={cn("size-3.5", className)} {...props} />;
}

const STREAMDOWN_ICONS = Object.freeze({
    CheckIcon: StreamdownCheckIcon,
    CopyIcon: StreamdownCopyIcon,
    DownloadIcon: StreamdownDownloadIcon,
    Maximize2Icon: StreamdownMaximize2Icon,
});

// Fenced code is one tinted surface, like inline code and tool output: the language label and
// the code share it, without an inner frame. Radius and spacing follow tables.
const STREAMDOWN_FENCED_CODE_BLOCK_CLASSES = [
    "[&_[data-streamdown=code-block]]:min-w-0 [&_[data-streamdown=code-block]]:max-w-full",
    "[&_[data-streamdown=code-block]]:!overflow-hidden",
    "[&_[data-streamdown=code-block]]:my-4",
    "[&_[data-streamdown=code-block]]:rounded-[16px]",
    "[&_[data-streamdown=code-block]]:!gap-0",
    "[&_[data-streamdown=code-block]]:!p-0",
    "[&_[data-streamdown=code-block]]:!border-0",
    "[&_[data-streamdown=code-block]]:!bg-muted",
    "[&_[data-streamdown=code-block-header]]:!h-auto [&_[data-streamdown=code-block-header]]:min-w-0 [&_[data-streamdown=code-block-header]]:px-4 [&_[data-streamdown=code-block-header]]:pt-3",
    "[&_[data-streamdown=code-block-header]>span]:!ml-0 [&_[data-streamdown=code-block-header]>span]:min-w-0 [&_[data-streamdown=code-block-header]>span]:truncate",
    "[&_[data-streamdown=code-block-body]]:flex [&_[data-streamdown=code-block-body]]:min-h-0 [&_[data-streamdown=code-block-body]]:flex-col [&_[data-streamdown=code-block-body]]:!overflow-hidden",
    "[&_[data-streamdown=code-block-body]]:!rounded-none",
    "[&_[data-streamdown=code-block-body]]:!border-0",
    "[&_[data-streamdown=code-block-body]]:!bg-transparent",
    "[&_[data-streamdown=code-block-body]]:!p-4",
    "[&_[data-streamdown=code-block-body]]:!text-[13px] [&_[data-streamdown=code-block-body]]:!leading-[1.6]",
    "[&_[data-streamdown=code-block-body]_pre]:min-h-0 [&_[data-streamdown=code-block-body]_pre]:flex-1 [&_[data-streamdown=code-block-body]_pre]:overflow-auto",
    // Prose has no column layout to preserve, so it wraps instead of hiding line ends behind a scrollbar.
    "[&_[data-streamdown=code-block-body]:is([data-language=markdown],[data-language=md],[data-language=text],[data-language=txt],[data-language=plaintext])_pre]:whitespace-pre-wrap",
    "[&_[data-streamdown=code-block-actions]]:!border-0",
    "[&_[data-streamdown=code-block-actions]]:!bg-transparent",
    "[&_[data-streamdown=code-block-actions]]:shadow-none",
    "[&_[data-streamdown=code-block-actions]]:backdrop-blur-none",
    "[&_[data-streamdown=code-block-actions]]:supports-[backdrop-filter]:!bg-transparent",
    "[&_[data-streamdown=code-block-actions]]:!p-0",
    "[&_[data-streamdown=code-block-copy-button]]:flex",
    "[&_[data-streamdown=code-block-copy-button]]:size-6",
    "[&_[data-streamdown=code-block-copy-button]]:items-center",
    "[&_[data-streamdown=code-block-copy-button]]:justify-center",
    "[&_[data-streamdown=code-block-copy-button]]:rounded-md",
    "[&_[data-streamdown=code-block-copy-button]]:!p-0",
    "[&_[data-streamdown=code-block-copy-button]]:text-muted-foreground",
    "[&_[data-streamdown=code-block-copy-button]]:transition-opacity",
    "[&_[data-streamdown=code-block-copy-button]]:hover:bg-black/[0.045]",
    "[&_[data-streamdown=code-block-copy-button]]:hover:text-foreground",
    "[&_[data-streamdown=code-block-copy-button]]:keyboard-focus:focus-visible:ring-[3px]",
    "[&_[data-streamdown=code-block-copy-button]]:keyboard-focus:focus-visible:ring-ring/60",
    "[&_[data-streamdown=code-block-copy-button]_svg]:size-3.5",
    "[&_[data-streamdown=inline-code]]:text-xs [&_[data-streamdown=inline-code]]:py-[1px] [&_[data-streamdown=inline-code]]:text-copy-secondary",
].join(" ");
const LOCAL_FILE_URL_ORIGIN = "https://local-file.morty.invalid";
const LATEX_DELIMITER_PATTERN = /(^|[^\\$])(?:\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+\$)/u;
export const MAX_MARKDOWN_CHARACTERS = 32 * 1024;

function parseStreamingMarkdownIntoBlocks(markdown: string): string[] {
    const lexer = new Lexer({ gfm: true });
    lexer.blockTokens(markdown);
    return Object.keys(lexer.tokens.links).length > 0 ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

function isSafeLink(href: string): boolean {
    return (
        href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:") || href.startsWith("#")
    );
}

function withoutSourceLocation(path: string): string {
    const value = path.replace(/:\d+(?::\d+)?$/u, "");
    return /^[A-Za-z]:[\\/]/u.test(value) ? value.replaceAll("/", "\\") : value;
}

function fileSystemPath(href: string): string | null {
    if (href.startsWith("file:")) {
        try {
            const url = new URL(href);
            if (url.protocol !== "file:" || url.host.length > 0) {
                return null;
            }
            const path = decodeURIComponent(url.pathname);
            return withoutSourceLocation(/^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path);
        } catch {
            return null;
        }
    }
    try {
        const decoded = decodeURI(href);
        return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(decoded) ? withoutSourceLocation(decoded) : null;
    } catch {
        return null;
    }
}

function relativeFilePath(href: string): string | null {
    try {
        const path = decodeURIComponent(href);
        return path.length > 0 && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|[?#])/iu.test(path) && !path.includes("\0")
            ? path
            : null;
    } catch {
        return null;
    }
}

export function localFilePath(href: string): string | null {
    try {
        const url = new URL(href);
        if (url.origin !== LOCAL_FILE_URL_ORIGIN) {
            return fileSystemPath(href);
        }
        const path = url.searchParams.get("path");
        return path === null ? null : (fileSystemPath(path) ?? relativeFilePath(path));
    } catch {
        return fileSystemPath(href);
    }
}

function encodeLocalFileUrl(path: string): string {
    const url = new URL(LOCAL_FILE_URL_ORIGIN);
    url.searchParams.set("path", path);
    return url.href;
}

function rewriteLocalMarkdownTargets(value: unknown): void {
    if (typeof value !== "object" || value === null) {
        return;
    }
    if (
        "type" in value &&
        (value.type === "image" || value.type === "link") &&
        "url" in value &&
        typeof value.url === "string"
    ) {
        // Relative targets refer to files in the session working directory for
        // both links and images, so rewrite them before URL hardening can see a
        // bare relative URL and replace the node with a blocked marker.
        const path = localFilePath(value.url) ?? relativeFilePath(value.url);
        if (path !== null) {
            value.url = encodeLocalFileUrl(path);
        }
    }
    if ("children" in value && Array.isArray(value.children)) {
        for (const child of value.children) {
            rewriteLocalMarkdownTargets(child);
        }
    }
}

function remarkLocalMarkdownTargets() {
    return rewriteLocalMarkdownTargets;
}

const STREAMDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkLocalMarkdownTargets];

const MarkdownResources = createContext<Pick<AgentMarkdownProps, "openLocalFile" | "readImage">>({});

function AgentMarkdownLink({ children, href }: ComponentProps<"a">) {
    const { openLocalFile } = useContext(MarkdownResources);
    const path = href === undefined ? null : localFilePath(href);
    if (path !== null && openLocalFile !== undefined) {
        return (
            <button
                className={cn("cursor-pointer font-inherit font-medium", textLinkClassName)}
                data-testid={dataTestId.localFileLink}
                onClick={(event) => {
                    // Preserve a return-focus target even on browsers that do not focus tapped buttons.
                    event.currentTarget.focus({ preventScroll: true });
                    openLocalFile(path);
                }}
                type="button"
            >
                {children}
            </button>
        );
    }
    // A local file reference without an opener stays plain text: the rewritten
    // placeholder URL has no destination a browser could visit.
    if (href === undefined || path !== null || !isSafeLink(href)) {
        return <span>{children}</span>;
    }
    return (
        <a href={href} rel="noopener noreferrer" target="_blank">
            {children}
        </a>
    );
}

/** Where an image Markdown names comes from: embedded data, another site, or the session's own files. */
function imageOrigin(value: string): { readonly kind: "embedded" | "remote"; readonly url: URL } | null {
    if (localFilePath(value) !== null || !URL.canParse(value)) {
        return null;
    }
    const url = new URL(value);
    if (url.protocol === "data:" && url.pathname.startsWith("image/")) {
        return { kind: "embedded", url };
    }
    if (url.protocol === "https:" || url.protocol === "http:") {
        return { kind: "remote", url };
    }
    return null;
}

type RemoteImageProps = Pick<ComponentProps<"img">, "alt" | "className" | "title"> & { readonly src: URL };

/**
 * An image on another site loads only when the user asks for it. Loading it on display would let whatever the Agent
 * read make it emit an image URL that carries data out the moment the message is shown.
 */
function RemoteMarkdownImage(props: RemoteImageProps) {
    const consent = useContext(RemoteImageConsent);
    if (consent === null) {
        return <span className="text-xs text-muted-foreground">Image from {props.src.host}</span>;
    }
    return <ConsentedRemoteImage consent={consent} {...props} />;
}

function ConsentedRemoteImage({
    alt,
    className,
    consent,
    src,
    title,
}: RemoteImageProps & { readonly consent: StoreApi<RemoteImageConsentModel> }) {
    const shown = useStore(consent, (model) => model.shown.has(src.href));
    if (shown) {
        return (
            <PreviewImage
                alt={alt ?? ""}
                className={cn("max-h-[min(60vh,360px)]", className)}
                loading="lazy"
                src={src.href}
                title={title}
            />
        );
    }
    return (
        // A placeholder where the image would be, not a link: nothing loads from the site until the user asks.
        <button
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70"
            onClick={() => consent.getState().show(src.href)}
            title={alt === undefined || alt.length === 0 ? undefined : alt}
            type="button"
        >
            <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
            Show image from {src.host}
        </button>
    );
}

function AgentMarkdownImage({ alt, className, src, title }: ComponentProps<"img">) {
    const { readImage } = useContext(MarkdownResources);
    const origin = typeof src === "string" ? imageOrigin(src) : null;
    const requestedSource = typeof src === "string" ? (localFilePath(src) ?? src) : "";
    if (origin?.kind === "remote") {
        return <RemoteMarkdownImage alt={alt} className={className} src={origin.url} title={title} />;
    }
    if (origin?.kind === "embedded") {
        return (
            <PreviewImage
                alt={alt ?? ""}
                className={cn("max-h-[min(60vh,360px)]", className)}
                loading="lazy"
                src={origin.url.href}
                title={title}
            />
        );
    }
    if (readImage === undefined) {
        return <span className="text-xs text-muted-foreground">Image not available</span>;
    }
    return (
        <SessionResource inline request={{ kind: "image", path: requestedSource }} read={readImage}>
            {(state) => {
                if (state.kind === "loading") {
                    return <span className="text-xs text-muted-foreground">Loading image…</span>;
                }
                if (state.kind !== "media") {
                    return <span className="text-xs text-muted-foreground">Image not available</span>;
                }
                return (
                    <PreviewImage
                        alt={alt ?? ""}
                        className={cn("max-h-[min(60vh,360px)]", className)}
                        loading="lazy"
                        blob={state.blob}
                        src={state.source}
                        title={title}
                    />
                );
            }}
        </SessionResource>
    );
}

export interface AgentMarkdownProps {
    readonly className?: string;
    readonly markdown: string;
    readonly openLocalFile?: ((path: string) => void) | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly sourceCharacters?: number | undefined;
    readonly streaming: boolean;
}

// Renderer identities must survive parent updates, including updates between
// pointer-down and click. Context supplies the latest callbacks without remounts.
const STREAMDOWN_COMPONENTS = { a: AgentMarkdownLink, img: AgentMarkdownImage };

interface AgentMarkdownContentProps extends AgentMarkdownProps {
    readonly mathPlugin?: MathPlugin | undefined;
}

export function AgentMarkdownContent({
    className,
    markdown,
    mathPlugin,
    openLocalFile,
    readImage,
    sourceCharacters = markdown.length,
    streaming,
}: AgentMarkdownContentProps) {
    const remarkPlugins = useMemo(() => {
        // Explicit options also distinguish Streamdown's cached parser configurations.
        const completion: [typeof remarkMermaidCompletion, { readonly streaming: boolean }] = [
            remarkMermaidCompletion,
            { streaming },
        ];
        return [completion, ...STREAMDOWN_REMARK_PLUGINS];
    }, [streaming]);
    const resources = useMemo(() => ({ openLocalFile, readImage }), [openLocalFile, readImage]);
    const plugins = useMemo(
        () => (mathPlugin === undefined ? STREAMDOWN_PLUGINS : { ...STREAMDOWN_PLUGINS, math: mathPlugin }),
        [mathPlugin],
    );
    return sourceCharacters > MAX_MARKDOWN_CHARACTERS ? (
        <pre
            className={cn(
                "m-0 min-w-0 whitespace-pre-wrap break-words font-sans text-base leading-6 text-foreground",
                className,
            )}
        >
            {markdown}
        </pre>
    ) : (
        <MarkdownResources value={resources}>
            <Streamdown
                className={cn(
                    "agent-markdown min-w-0 text-base leading-6 text-foreground [overflow-wrap:anywhere]",
                    "[&_p]:my-2 [&_p]:whitespace-pre-line",
                    "[&_h1]:mt-10 [&_h1]:mb-5 [&_h1]:text-[24px] [&_h1]:leading-[30px] [&_h1]:font-semibold",
                    "[&_h2]:mt-8 [&_h2]:mb-4 [&_h2]:text-[20px] [&_h2]:leading-[26px] [&_h2]:font-semibold",
                    "[&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:text-[16px] [&_h3]:leading-6 [&_h3]:font-semibold",
                    "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:leading-6 [&_h4]:font-semibold",
                    "[&_h5]:mt-4 [&_h5]:mb-2 [&_h5]:text-base [&_h5]:leading-6 [&_h5]:font-semibold",
                    "[&_h6]:mt-4 [&_h6]:mb-2 [&_h6]:text-base [&_h6]:leading-6 [&_h6]:font-semibold",
                    "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
                    "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
                    "[&_li]:py-0",
                    // Explicit margins instead of space-y: nested-list rules must beat
                    // top-level ones by specificity, not Tailwind's output order.
                    "[&_ul>li:not(:last-child)]:mb-1.5 [&_ol>li:not(:last-child)]:mb-1.5",
                    "[&_li_ul>li:not(:last-child)]:mb-1 [&_li_ol>li:not(:last-child)]:mb-1",
                    "[&_li_ul]:mt-1 [&_li_ul]:mb-0 [&_li_ol]:mt-1 [&_li_ol]:mb-0",
                    "[&_li>p]:my-0",
                    "[&_blockquote]:my-4 [&_blockquote]:border-l-[3px] [&_blockquote]:border-black/12 [&_blockquote]:py-2 [&_blockquote]:pl-3 [&_blockquote]:leading-6 [&_blockquote]:not-italic [&_blockquote]:text-[#454959] [&_blockquote_p]:my-0",
                    "[&_hr]:border-t-[0.5px]",
                    "[&_a]:font-medium [&_a]:text-primary [&_a]:transition-colors [&_a]:hover:text-primary-hover [&_a]:active:text-primary-active",
                    "[&_code]:font-mono",
                    "[&_table]:text-[13px] [&_th]:text-[13px] [&_th]:px-2.5 [&_[data-streamdown=table-header-cell]]:py-2.5 [&_td]:text-[13px] [&_td]:px-2.5 [&_[data-streamdown=table-cell]]:py-2.5",
                    "[&_[data-streamdown=table-wrapper]]:relative [&_[data-streamdown=table-wrapper]]:!border-0 [&_[data-streamdown=table-wrapper]]:!bg-transparent [&_[data-streamdown=table-wrapper]]:!p-0",
                    // The download/fullscreen actions float over the table's top-right
                    // corner and appear on wrapper hover or keyboard focus. `:not(:last-child)`
                    // keeps the selector off the scroll container when no action row renders,
                    // and the chip background matches the header cells. `.flex` (the row's own
                    // streamdown class) makes these rules win on specificity, not on stylesheet
                    // order: Tailwind sorts equal-specificity utilities by its own criteria, so
                    // a stale or competing candidate emitted later would otherwise override them.
                    // Hover/active fills stack as background-image layers over the opaque
                    // bg-background color, so the chip never lets content underneath show through.
                    // A solid tint layer repeats its color stop: a one-stop linear-gradient is
                    // invalid CSS and browsers would drop the whole background-image.
                    // The row itself is a 36px pill — 4px padding around the 28px buttons, so
                    // left/right padding equals the vertical padding, and the 10px radius is
                    // concentric with the buttons' 6px — wearing the same chip as the buttons.
                    // !top/!right keep the centered placement against stale-cache candidates
                    // holding the older 6px offsets at equal specificity.
                    "[&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:absolute [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:!top-0.5 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:!right-0.5 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:z-20 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:h-9 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:rounded-[10px] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:bg-background [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:bg-[linear-gradient(color-mix(in_oklab,var(--muted)_80%,transparent),color-mix(in_oklab,var(--muted)_80%,transparent))] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:px-1 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:opacity-0 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:pointer-events-none [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:transition-opacity [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:duration-150 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:motion-reduce:transition-none",
                    "[&_[data-streamdown=table-wrapper]:hover>div.flex:first-child:not(:last-child)]:opacity-100 [&_[data-streamdown=table-wrapper]:hover>div.flex:first-child:not(:last-child)]:pointer-events-auto [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)]:focus-within:opacity-100",
                    "[&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:flex [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:size-7 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:items-center [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:justify-center [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:!p-0 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:rounded-md [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:bg-background [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:bg-[linear-gradient(color-mix(in_oklab,var(--muted)_80%,transparent),color-mix(in_oklab,var(--muted)_80%,transparent))] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:text-morty-text-3 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:hover:bg-[linear-gradient(var(--morty-fill-opacity-2),var(--morty-fill-opacity-2)),linear-gradient(color-mix(in_oklab,var(--muted)_80%,transparent),color-mix(in_oklab,var(--muted)_80%,transparent)),linear-gradient(var(--background),var(--background))] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:hover:text-foreground [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:active:bg-[linear-gradient(var(--morty-fill-opacity-3),var(--morty-fill-opacity-3)),linear-gradient(color-mix(in_oklab,var(--muted)_80%,transparent),color-mix(in_oklab,var(--muted)_80%,transparent)),linear-gradient(var(--background),var(--background))] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:active:text-foreground [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:keyboard-focus:focus-visible:ring-[3px] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_button:has(svg)]:keyboard-focus:focus-visible:ring-ring/60",
                    // The download dropdown (CSV/Markdown) is plain streamdown markup inside the
                    // action row; restyle it to the app menu recipe: overlay-surface panel
                    // (border-white, overlay radius + shadow, 6px trigger offset) with the
                    // rounded-full h-9 items and morty-fill hover/active used by app menus.
                    "[&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:mt-1.5 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:rounded-overlay [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:border-white [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:p-1.5 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:text-foreground [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:shadow-[0_16px_42px_rgba(0,0,0,0.14)] [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:animate-cloud-enter [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute]:motion-reduce:animate-none",
                    "[&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:flex [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:h-9 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:w-full [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:items-center [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:justify-start [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:!px-3 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:rounded-full [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:bg-transparent [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:bg-none [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:text-foreground [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:hover:bg-morty-fill-opacity-2 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:active:bg-morty-fill-opacity-3 [&_[data-streamdown=table-wrapper]>div.flex:first-child:not(:last-child)_div.absolute>button]:motion-reduce:transition-none",
                    // No height cap: the table renders at full height and vertical scrolling
                    // belongs to the message list, so no internal vertical scrollbar appears.
                    // The container keeps overflow-x as the safety net for wide tables.
                    "[&_[data-streamdown=table-wrapper]>div:last-child]:!border-border/50 [&_[data-streamdown=table-wrapper]>div:last-child]:!max-h-none",
                    "[&_[data-streamdown=table-row]]:!border-border/50",
                    // Collapsed grid borders paint on the table grid rather than on the header
                    // cells, so the divider under the header is an inset shadow instead, and the
                    // header tint stacks on an opaque background matching what bg-muted/80 over
                    // the container's bg-background renders.
                    "[&_[data-streamdown=table-header]]:border-b-0",
                    "[&_[data-streamdown=table-header-cell]]:bg-background [&_[data-streamdown=table-header-cell]]:bg-[linear-gradient(color-mix(in_oklab,var(--muted)_80%,transparent),color-mix(in_oklab,var(--muted)_80%,transparent))]",
                    "[&_[data-streamdown=table-header-cell]]:shadow-[inset_0_-0.5px_0_color-mix(in_oklab,var(--border)_50%,transparent)]",
                    STREAMDOWN_FENCED_CODE_BLOCK_CLASSES,
                    className,
                )}
                components={STREAMDOWN_COMPONENTS}
                controls={STREAMDOWN_CONTROLS}
                icons={STREAMDOWN_ICONS}
                isAnimating={streaming}
                lineNumbers={false}
                // Keep the same block tree when a turn completes, including between pointer down and click.
                mode="streaming"
                parseIncompleteMarkdown={streaming}
                parseMarkdownIntoBlocksFn={parseStreamingMarkdownIntoBlocks}
                plugins={plugins}
                rehypePlugins={STREAMDOWN_REHYPE_PLUGINS}
                remarkPlugins={remarkPlugins}
                remend={STREAMDOWN_REMEND}
                translations={STREAMDOWN_TRANSLATIONS}
            >
                {markdown}
            </Streamdown>
        </MarkdownResources>
    );
}

export function AgentMarkdown(properties: AgentMarkdownProps) {
    const sourceCharacters = properties.sourceCharacters ?? properties.markdown.length;
    return (
        <ImageGallery>
            {sourceCharacters > MAX_MARKDOWN_CHARACTERS || !LATEX_DELIMITER_PATTERN.test(properties.markdown) ? (
                <AgentMarkdownContent {...properties} />
            ) : (
                <AgentMarkdownWithLatexWhenReady {...properties} />
            )}
        </ImageGallery>
    );
}

type LatexRenderer = typeof import("./agent-markdown-with-latex.tsx")["AgentMarkdownWithLatex"];
let latexRenderer: Promise<LatexRenderer> | null = null;

/**
 * Loads the LaTeX renderer as an explicit state transition. The Suspense
 * fallback swap can drop the resolved component's DOM commit under load,
 * which leaves the interim non-math render stuck; rendering from resolved
 * state commits deterministically.
 */
export function loadLatexRenderer(): Promise<LatexRenderer> {
    latexRenderer ??= import("./agent-markdown-with-latex.tsx").then(
        (module) => module.AgentMarkdownWithLatex,
        // A failed chunk import degrades to the non-math render instead of an
        // unhandled rejection; consumers render markdown either way.
        () => AgentMarkdownContent,
    );
    return latexRenderer;
}

function AgentMarkdownWithLatexWhenReady(properties: AgentMarkdownProps) {
    const [renderer, setRenderer] = useState<LatexRenderer | null>(null);
    useEffect(() => {
        let active = true;
        void loadLatexRenderer().then((component) => {
            if (active) {
                setRenderer(() => component);
            }
        });
        return () => {
            active = false;
        };
    }, []);
    if (renderer === null) {
        return <AgentMarkdownContent {...properties} />;
    }
    const Latex = renderer;
    return <Latex {...properties} />;
}
