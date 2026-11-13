import { MortyError } from "@morty-build/client";
import { createStore } from "zustand/vanilla";
import { MAX_MARKDOWN_CHARACTERS } from "../../components/agents/agent-markdown.tsx";
import { isDisplayableImageType } from "../../components/agents/displayable-image-type.ts";
import type { SessionResourceReader } from "../../components/agents/resource-reader.ts";
import {
    attachFilePreviewPanel,
    createFilePreviewImage,
    filePreviewAllowsSidePanel,
    observeFilePreviewLayout,
} from "../../services/chat/file-preview-surface.ts";
import {
    attachHtmlPreview,
    createHtmlPreviewDocument,
    type HtmlPreviewDocument,
    type HtmlPreviewFailure,
} from "../../services/chat/html-preview-document.ts";
import { downloadLocalFile } from "../../services/chat/local-file-download.ts";

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|x-httpd-php|x-sh|x-yaml))(?:;|$)/u;
const TEXT_EXTENSIONS = new Set([
    "bash",
    "c",
    "cc",
    "conf",
    "cpp",
    "css",
    "csv",
    "env",
    "go",
    "graphql",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "jsx",
    "json",
    "log",
    "md",
    "mdx",
    "php",
    "properties",
    "py",
    "rb",
    "rs",
    "sh",
    "sql",
    "svg",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
    "zsh",
]);
const TEXT_NAMES = new Set(["dockerfile", "gemfile", "license", "makefile", "readme"]);

export type FilePreviewState =
    | { readonly kind: "closed" }
    | { readonly kind: "loading"; readonly path: string }
    | { readonly kind: "text"; readonly name: string; readonly path: string; readonly text: string }
    | {
          readonly kind: "markdown";
          readonly name: string;
          readonly path: string;
          readonly text: string;
          readonly view: { readonly kind: "preview" } | { readonly kind: "source" };
      }
    | {
          readonly kind: "html";
          readonly name: string;
          readonly path: string;
          readonly text: string;
          readonly view:
              | { readonly kind: "source" }
              | {
                    readonly kind: "preview";
                    readonly document: HtmlPreviewDocument;
                    readonly diagnostic:
                        | { readonly kind: "none" }
                        | { readonly kind: "failed"; readonly code: HtmlPreviewFailure; readonly message: string };
                };
      }
    | {
          readonly kind: "image";
          readonly source: string;
          readonly blob: Blob;
          readonly name: string;
          readonly path: string;
      }
    | {
          readonly kind: "failed";
          readonly code: "timeout" | "offline" | "unavailable";
          readonly message: string;
          readonly path: string;
      };

export type FilePreviewLayout =
    | { readonly kind: "desktop"; readonly size: "side-panel" | "expanded" }
    | { readonly kind: "mobile"; readonly desktopSize: "side-panel" | "expanded" };

interface FilePreviewStore {
    readonly state: FilePreviewState;
    readonly layout: FilePreviewLayout;
    readonly close: () => void;
    readonly open: (path: string, signal: AbortSignal) => Promise<void>;
    readonly reload: (signal: AbortSignal) => Promise<void>;
    readonly showView: (view: "preview" | "source") => void;
    readonly openMarkdownLink: (path: string, signal: AbortSignal) => Promise<void>;
    readonly readMarkdownImage: SessionResourceReader;
    readonly reportHtmlFailure: (id: string, code: HtmlPreviewFailure) => void;
    readonly toggleExpanded: () => void;
    readonly onPanelAttach: (panel: HTMLDialogElement) => () => void;
    readonly onHtmlAttach: (frame: HTMLIFrameElement) => () => void;
}

interface LocalFileResult {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly name: string;
}

function desktopSize(layout: FilePreviewLayout): "side-panel" | "expanded" {
    return layout.kind === "desktop" ? layout.size : layout.desktopSize;
}

function previewLayout(sidePanel: boolean, size: "side-panel" | "expanded"): FilePreviewLayout {
    return sidePanel ? { kind: "desktop", size } : { kind: "mobile", desktopSize: size };
}

function panelMode(layout: FilePreviewLayout): "side-panel" | "modal" {
    return layout.kind === "desktop" && layout.size === "side-panel" ? "side-panel" : "modal";
}

function isTextFile(file: LocalFileResult): boolean {
    if (TEXT_MIME.test(file.mediaType.toLowerCase())) {
        return true;
    }
    const name = file.name.toLowerCase();
    if (TEXT_NAMES.has(name)) {
        return true;
    }
    const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
    return TEXT_EXTENSIONS.has(extension);
}

function isHtmlFile(file: LocalFileResult): boolean {
    return /^text\/html(?:;|$)/iu.test(file.mediaType) || /\.html?$/iu.test(file.name);
}

function isMarkdownFile(file: LocalFileResult): boolean {
    return /^text\/(?:markdown|x-markdown)(?:;|$)/iu.test(file.mediaType) || /\.(?:md|markdown)$/iu.test(file.name);
}

// File links and images are relative to the document, not the Agent's working directory.
// Normalize dot segments because the Runtime rejects non-canonical absolute paths;
// the Runtime still resolves and authorizes the resulting path at its own boundary.
function markdownTargetPath(documentPath: string, target: string): string {
    if (/^(?:[\\/]|[A-Za-z]:[\\/])/u.test(target)) {
        return target;
    }
    const path = documentPath.replaceAll("\\", "/");
    const joined = path.slice(0, path.lastIndexOf("/") + 1) + target.replaceAll("\\", "/");
    const root = joined.match(/^(?:\/+|[A-Za-z]:\/)/u)?.[0] ?? "";
    const segments: string[] = [];
    for (const segment of joined.slice(root.length).split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
            segments.pop();
        } else if (segment !== ".." || root === "") {
            segments.push(segment);
        }
    }
    const resolved = root + segments.join("/");
    return documentPath.includes("\\") ? resolved.replaceAll("/", "\\") : resolved;
}

const HTML_FAILURE_MESSAGES: Readonly<Record<HtmlPreviewFailure, string>> = {
    policy: "This page uses a resource or capability that previews do not allow. You can inspect its source or reload.",
    resource: "A page resource could not be loaded. Check your connection, reload, or inspect the source.",
    script: "The page reported a script error. You can inspect its source or reload.",
};

function readFailure(cause: unknown, timedOut: boolean, path: string): Extract<FilePreviewState, { kind: "failed" }> {
    const code = cause instanceof MortyError ? cause.code : null;
    if (timedOut || code === "operation_timeout") {
        return { kind: "failed", code: "timeout", path, message: "The local file preview timed out. Try reloading." };
    }
    if (code === "computer_offline" || code === "session_not_connected") {
        return {
            kind: "failed",
            code: "offline",
            path,
            message: "Your computer is offline or disconnected. Reconnect it, then reload the file.",
        };
    }
    return {
        kind: "failed",
        code: "unavailable",
        path,
        message: "The local file could not be opened. Check that it is available, then reload.",
    };
}

export function createBrowserFilePreviewStore(read: (path: string, signal: AbortSignal) => Promise<LocalFileResult>) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let active: AbortController | null = null;
    // The preview owns these resources. Refs only announce DOM availability;
    // transitions also release content before React detaches the previous view.
    let releasePanel: (() => void) | null = null;
    let releaseHtml: (() => void) | null = null;
    let releaseImage: (() => void) | null = null;
    const releaseContent = () => {
        releaseHtml?.();
        releaseImage?.();
        releaseImage = null;
    };
    // Panel layout followers, notified at the explicit sites that change the
    // layout: the attached panel reacts without a store subscription.
    const layoutFollowers = new Set<(layout: FilePreviewStore["layout"]) => void>();
    const store = createStore<FilePreviewStore>()((set, get) => ({
        state: { kind: "closed" },
        layout: previewLayout(filePreviewAllowsSidePanel(), "side-panel"),
        close: () => {
            active?.abort();
            active = null;
            releaseContent();
            releasePanel?.();
            set({ state: { kind: "closed" }, layout: previewLayout(get().layout.kind === "desktop", "side-panel") });
            for (const follow of layoutFollowers) {
                follow(get().layout);
            }
        },
        toggleExpanded: () => {
            const { state, layout } = get();
            if (state.kind !== "closed" && layout.kind === "desktop") {
                set({ layout: { kind: "desktop", size: layout.size === "expanded" ? "side-panel" : "expanded" } });
                for (const follow of layoutFollowers) {
                    follow(get().layout);
                }
            }
        },
        onPanelAttach: (node) => {
            releasePanel?.();
            const panel = attachFilePreviewPanel(node);
            const followLayout = (layout: FilePreviewStore["layout"]): void => {
                panel.show(panelMode(layout));
            };
            layoutFollowers.add(followLayout);
            const stopLayout = observeFilePreviewLayout((sidePanel) => {
                set({ layout: previewLayout(sidePanel, desktopSize(get().layout)) });
                for (const follow of layoutFollowers) {
                    follow(get().layout);
                }
            });
            panel.show(panelMode(get().layout));
            const release = () => {
                if (releasePanel !== release) {
                    return;
                }
                releasePanel = null;
                layoutFollowers.delete(followLayout);
                stopLayout();
                panel.dispose();
            };
            releasePanel = release;
            return release;
        },
        onHtmlAttach: (frame) => {
            releaseHtml?.();
            const { state, reportHtmlFailure } = get();
            if (state.kind !== "html" || state.view.kind !== "preview") {
                return () => {};
            }
            const stop = attachHtmlPreview(frame, state.view.document, reportHtmlFailure);
            const release = () => {
                if (releaseHtml !== release) {
                    return;
                }
                releaseHtml = null;
                stop();
            };
            releaseHtml = release;
            return release;
        },
        reload: async (signal) => {
            const { state, open } = get();
            if (state.kind !== "closed" && state.kind !== "loading") {
                await open(state.path, signal);
            }
        },
        openMarkdownLink: async (path, signal) => {
            const { state, open } = get();
            if (state.kind === "markdown") {
                await open(markdownTargetPath(state.path, path), signal);
            }
        },
        readMarkdownImage: async (path, signal) => {
            signal.throwIfAborted();
            const { state } = get();
            if (state.kind !== "markdown") {
                throw new DOMException("The Markdown preview is closed.", "AbortError");
            }
            return await read(markdownTargetPath(state.path, path), signal);
        },
        showView: (view) => {
            const { state } = get();
            if (state.kind === "markdown") {
                if (view === "source" || state.text.length <= MAX_MARKDOWN_CHARACTERS) {
                    set({ state: { ...state, view: { kind: view } } });
                }
                return;
            }
            if (state.kind !== "html" || state.view.kind === view) {
                return;
            }
            releaseHtml?.();
            set({
                state: {
                    ...state,
                    view:
                        view === "preview"
                            ? {
                                  kind: "preview",
                                  document: createHtmlPreviewDocument(state.text),
                                  diagnostic: { kind: "none" },
                              }
                            : { kind: "source" },
                },
            });
        },
        reportHtmlFailure: (id, code) => {
            const { state } = get();
            if (
                state.kind === "html" &&
                state.view.kind === "preview" &&
                state.view.document.id === id &&
                state.view.diagnostic.kind === "none"
            ) {
                set({
                    state: {
                        ...state,
                        view: {
                            ...state.view,
                            diagnostic: { kind: "failed", code, message: HTML_FAILURE_MESSAGES[code] },
                        },
                    },
                });
            }
        },
        open: async (path, signal) => {
            signal.throwIfAborted();
            active?.abort();
            releaseContent();
            const controller = new AbortController();
            active = controller;
            const timeoutSignal = AbortSignal.timeout(20_000);
            const operationSignal = AbortSignal.any([signal, controller.signal, timeoutSignal]);
            set({ state: { kind: "loading", path } });
            try {
                const file = await read(path, operationSignal);
                operationSignal.throwIfAborted();
                if (active !== controller) {
                    return;
                }
                if (isDisplayableImageType(file.mediaType)) {
                    const image = createFilePreviewImage(file.bytes, file.mediaType);
                    releaseImage = image.dispose;
                    set({
                        state: {
                            kind: "image",
                            source: image.source,
                            blob: image.blob,
                            name: file.name,
                            path,
                        },
                    });
                    return;
                }
                if (isMarkdownFile(file)) {
                    const text = decoder.decode(file.bytes);
                    set({
                        state: {
                            kind: "markdown",
                            name: file.name,
                            path,
                            text,
                            view: { kind: text.length > MAX_MARKDOWN_CHARACTERS ? "source" : "preview" },
                        },
                    });
                    return;
                }
                if (isHtmlFile(file) || isTextFile(file)) {
                    try {
                        const text = decoder.decode(file.bytes);
                        set({
                            state: isHtmlFile(file)
                                ? {
                                      kind: "html",
                                      name: file.name,
                                      path,
                                      text,
                                      view: {
                                          kind: "preview",
                                          document: createHtmlPreviewDocument(text),
                                          diagnostic: { kind: "none" },
                                      },
                                  }
                                : { kind: "text", name: file.name, path, text },
                        });
                        return;
                    } catch {}
                }
                downloadLocalFile(file);
                get().close();
            } catch (cause) {
                if (controller.signal.aborted) {
                    return;
                }
                signal.throwIfAborted();
                if (active === controller) {
                    set({ state: readFailure(cause, timeoutSignal.aborted, path) });
                }
            } finally {
                if (active === controller) {
                    active = null;
                }
            }
        },
    }));
    return store;
}
