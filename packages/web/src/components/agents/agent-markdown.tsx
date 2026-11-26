import { type ReactNode, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import type { SessionResourceReader as MarkdownImageReader } from "./resource-reader.ts";

export type { SessionResourceReader as MarkdownImageReader } from "./resource-reader.ts";

export const MAX_MARKDOWN_CHARACTERS = 32 * 1024;

export interface AgentMarkdownProps {
    readonly className?: string;
    readonly markdown: string;
    readonly openLocalFile?: ((path: string) => void) | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly sourceCharacters?: number | undefined;
    readonly streaming: boolean;
}

type MarkdownRenderer =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly component: typeof import("./agent-markdown-renderer.tsx")["AgentMarkdownRenderer"];
      }
    | { readonly kind: "failed" };

let renderer: MarkdownRenderer = { kind: "loading" };
const rendererListeners = new Set<() => void>();

function settleRenderer(settled: Exclude<MarkdownRenderer, { readonly kind: "loading" }>): void {
    renderer = settled;
    for (const listener of rendererListeners) {
        listener();
    }
}

// The renderer is most of the startup bundle, and no page needs it for its first paint. Loading starts
// with the page, beside authorization and the Computer connection, so it is normally ready before history.
void import("./agent-markdown-renderer.tsx").then(
    (module) => settleRenderer({ kind: "ready", component: module.AgentMarkdownRenderer }),
    // A failed chunk import degrades to plain text instead of an unhandled rejection.
    () => settleRenderer({ kind: "failed" }),
);

function subscribeRenderer(listener: () => void): () => void {
    rendererListeners.add(listener);
    return () => {
        rendererListeners.delete(listener);
    };
}

function useMarkdownRenderer(): MarkdownRenderer {
    return useSyncExternalStore(subscribeRenderer, () => renderer);
}

export function AgentMarkdown(properties: AgentMarkdownProps) {
    const current = useMarkdownRenderer();
    switch (current.kind) {
        case "ready": {
            const Rendered = current.component;
            return <Rendered {...properties} />;
        }
        case "loading":
        case "failed":
            return (
                <div className={cn("whitespace-pre-wrap break-words", properties.className)}>{properties.markdown}</div>
            );
    }
}

/**
 * Shows `fallback` until the Markdown renderer has settled, so a conversation does not first show its
 * replies as raw Markdown source and then reflow them.
 */
export function AgentMarkdownReady({
    children,
    fallback,
}: {
    readonly children: ReactNode;
    readonly fallback: ReactNode;
}) {
    return useMarkdownRenderer().kind === "loading" ? fallback : children;
}
