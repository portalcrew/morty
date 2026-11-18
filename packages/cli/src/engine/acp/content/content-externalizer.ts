import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { z } from "zod";

interface ExtractedContent {
    readonly bytes: Uint8Array;
    readonly kind: "image" | "audio" | "resource";
    readonly mediaType: string;
    readonly name: string;
}

export type StoreExtractedContent = (
    sessionTarget: NativeSessionTarget,
    content: ExtractedContent,
    signal: AbortSignal,
) => Promise<{ readonly byteLength: number; readonly key: string }>;

import { sniffRasterMime } from "./raster.ts";

const MAXIMUM_ENCODED_CONTENT_CHARACTERS = 4_000_000;
// Match the event wire's UTF-16 bound, including the omission marker.
const MAXIMUM_TEXT_CHARACTERS = 1_000_000;

function boundedText(text: string): string {
    if (text.length <= MAXIMUM_TEXT_CHARACTERS) {
        return text;
    }
    const marker = (start: number): string => `... [omit ${text.length - start} characters since ${start}]`;
    let start = 0;
    let upper = MAXIMUM_TEXT_CHARACTERS;
    while (start < upper) {
        const candidate = Math.ceil((start + upper) / 2);
        if (candidate + marker(candidate).length <= MAXIMUM_TEXT_CHARACTERS) {
            start = candidate;
        } else {
            upper = candidate - 1;
        }
    }
    const last = text.charCodeAt(start - 1);
    const next = text.charCodeAt(start);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        start -= 1;
    }
    return text.slice(0, start) + marker(start);
}

function decodeBase64(data: string): Uint8Array {
    if (
        data.length > MAXIMUM_ENCODED_CONTENT_CHARACTERS ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
    ) {
        throw new Error("The ACP embedded content is not valid bounded base64");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) {
        throw new Error("The ACP embedded content is not canonical base64");
    }
    return bytes;
}

interface PreparedContent {
    readonly agent: ContentBlock;
    readonly event: unknown;
}

export interface PreparedAcpUpdate {
    readonly agent: SessionUpdate;
    readonly events: readonly unknown[];
}

type FindLinkedResources = (
    text: string,
) => readonly { readonly uri: string; readonly mediaType: string; readonly name: string }[];
export type ExternalizeSessionUpdate = (
    sessionId: string,
    update: SessionUpdate,
    signal: AbortSignal,
) => Promise<PreparedAcpUpdate>;

const embeddedImageSchema = z.looseObject({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
});

const inlineImageUrlSchema = z
    .string()
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,/u)
    .transform((url) => ({
        type: "image" as const,
        data: url.slice(url.indexOf(",") + 1),
        mimeType: url.slice(5, url.indexOf(";")),
    }));

const toolImageSchema = z.union([
    embeddedImageSchema,
    z
        .object({ type: z.literal("file"), mime: z.string(), url: inlineImageUrlSchema })
        .refine(({ mime, url }) => mime === url.mimeType)
        .transform(({ url }) => url),
    z.object({ type: z.literal("inputImage"), imageUrl: inlineImageUrlSchema }).transform(({ imageUrl }) => imageUrl),
    z
        .object({
            type: z.literal("image"),
            source: z.object({ type: z.literal("base64"), data: z.string(), media_type: z.string() }),
        })
        .transform(({ source }) => ({ type: "image" as const, data: source.data, mimeType: source.media_type })),
    z
        .object({
            type: z.literal("image"),
            file: z.object({ base64: z.string(), type: z.string() }),
        })
        .transform(({ file }) => ({ type: "image" as const, data: file.base64, mimeType: file.type })),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AcpContentExternalizer {
    readonly #store: StoreExtractedContent;
    readonly #linkedResources: FindLinkedResources;

    constructor(store: StoreExtractedContent, linkedResources: FindLinkedResources = () => []) {
        this.#store = store;
        this.#linkedResources = linkedResources;
    }

    #resourceLinks(text: string): readonly ContentBlock[] {
        return this.#linkedResources(text).map((resource) => ({
            type: "resource_link",
            uri: resource.uri,
            name: resource.name,
            mimeType: resource.mediaType,
        }));
    }

    async #content(
        sessionTarget: NativeSessionTarget,
        content: ContentBlock,
        signal: AbortSignal,
    ): Promise<PreparedContent> {
        switch (content.type) {
            case "text":
                return { agent: content, event: { ...content, text: boundedText(content.text) } };
            case "resource_link":
                return { agent: content, event: content };
            case "image": {
                if (content.data.length === 0) {
                    return { agent: content, event: content };
                }
                try {
                    const bytes = decodeBase64(content.data);
                    if (sniffRasterMime(bytes) !== content.mimeType) {
                        throw new Error("Embedded image bytes do not match a supported image MIME type");
                    }
                    const stored = await this.#store(
                        sessionTarget,
                        { bytes, kind: "image", mediaType: content.mimeType, name: "image" },
                        signal,
                    );
                    return {
                        agent: { ...content, data: "", uri: `morty-content:image:${stored.key}` },
                        event: {
                            _meta: content._meta,
                            annotations: content.annotations,
                            byteLength: stored.byteLength,
                            imageKey: stored.key,
                            mimeType: content.mimeType,
                            type: "external_image",
                            uri: content.uri,
                        },
                    };
                } catch {
                    signal.throwIfAborted();
                    const unavailable: ContentBlock = { type: "text", text: "[Image unavailable]" };
                    return { agent: unavailable, event: unavailable };
                }
            }
            case "audio": {
                if (content.data.length === 0) {
                    return { agent: content, event: content };
                }
                const stored = await this.#store(
                    sessionTarget,
                    { bytes: decodeBase64(content.data), kind: "audio", mediaType: content.mimeType, name: "audio" },
                    signal,
                );
                return {
                    agent: content,
                    event: {
                        _meta: content._meta,
                        annotations: content.annotations,
                        audioKey: stored.key,
                        byteLength: stored.byteLength,
                        mimeType: content.mimeType,
                        type: "external_audio",
                    },
                };
            }
            case "resource": {
                const embedded = content.resource;
                const encoding = "text" in embedded ? "text" : "binary";
                const bytes = "text" in embedded ? Buffer.from(embedded.text, "utf8") : decodeBase64(embedded.blob);
                if (bytes.byteLength === 0) {
                    return { agent: content, event: content };
                }
                const mediaType = embedded.mimeType ?? "application/octet-stream";
                const stored = await this.#store(
                    sessionTarget,
                    { bytes, kind: "resource", mediaType, name: "resource" },
                    signal,
                );
                return {
                    agent: content,
                    event: {
                        _meta: content._meta,
                        annotations: content.annotations,
                        byteLength: stored.byteLength,
                        encoding,
                        mimeType: embedded.mimeType,
                        resourceKey: stored.key,
                        type: "external_resource",
                        uri: embedded.uri,
                    },
                };
            }
        }
    }

    async #rawOutput(
        sessionTarget: NativeSessionTarget,
        value: unknown,
        images: Map<string, PreparedContent>,
        signal: AbortSignal,
        depth = 0,
    ): Promise<unknown> {
        signal.throwIfAborted();
        if (depth > 16) {
            throw new Error("ACP tool output exceeds the maximum nesting depth");
        }
        if (Array.isArray(value)) {
            const result: unknown[] = [];
            for (const item of value) {
                result.push(await this.#rawOutput(sessionTarget, item, images, signal, depth + 1));
            }
            return result;
        }
        if (!isRecord(value)) {
            return value;
        }
        const image = toolImageSchema.safeParse(value);
        if (image.success && image.data.data.length > 0) {
            const prepared = await this.#content(sessionTarget, image.data, signal);
            if (isRecord(prepared.event) && typeof prepared.event["imageKey"] === "string") {
                images.set(prepared.event["imageKey"], prepared);
            } else {
                images.set(`unavailable:${images.size}`, prepared);
            }
            // Replace the image object itself: retaining `data` here duplicates it in
            // tool JSON even when the visible ACP content already uses a reference.
            return prepared.event;
        }
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = await this.#rawOutput(sessionTarget, item, images, signal, depth + 1);
        }
        return result;
    }

    async #toolUpdate(
        sessionTarget: NativeSessionTarget,
        update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
        signal: AbortSignal,
    ): Promise<PreparedAcpUpdate> {
        const images = new Map<string, PreparedContent>();
        const rawOutput =
            update.rawOutput === undefined
                ? undefined
                : await this.#rawOutput(sessionTarget, update.rawOutput, images, signal);
        const metadata =
            update._meta === undefined || update._meta === null
                ? update._meta
                : z
                      .record(z.string(), z.unknown())
                      .parse(await this.#rawOutput(sessionTarget, update._meta, images, signal));
        const originalJson = images.size === 0 ? undefined : JSON.stringify(update.rawOutput);
        const rewrittenJson = images.size === 0 ? undefined : JSON.stringify(rawOutput);
        const agentContent: ToolCallContent[] = [];
        const eventContent: unknown[] = [];
        for (const item of update.content ?? []) {
            if (item.type !== "content") {
                agentContent.push(item);
                eventContent.push(item);
                continue;
            }
            const content =
                item.content.type === "text" && item.content.text === originalJson && rewrittenJson !== undefined
                    ? { ...item.content, text: rewrittenJson }
                    : item.content;
            const prepared = await this.#content(sessionTarget, content, signal);
            agentContent.push({ ...item, content: prepared.agent });
            eventContent.push({ ...item, content: prepared.event });
            if (isRecord(prepared.event) && typeof prepared.event["imageKey"] === "string") {
                images.delete(prepared.event["imageKey"]);
            }
        }
        for (const prepared of images.values()) {
            agentContent.push({ type: "content", content: prepared.agent });
            eventContent.push({ type: "content", content: prepared.event });
        }
        const output = update.rawOutput === undefined ? {} : { rawOutput };
        const meta = metadata === undefined ? {} : { _meta: metadata };
        const hasContent = (update.content !== undefined && update.content !== null) || agentContent.length > 0;
        return {
            agent: { ...update, ...meta, ...output, ...(hasContent ? { content: agentContent } : {}) },
            events: [{ ...update, ...meta, ...output, ...(hasContent ? { content: eventContent } : {}) }],
        };
    }

    readonly update = async (
        sessionTarget: NativeSessionTarget,
        update: SessionUpdate,
        signal: AbortSignal,
    ): Promise<PreparedAcpUpdate> => {
        switch (update.sessionUpdate) {
            case "agent_thought_chunk":
            case "user_message_chunk":
            case "agent_message_chunk":
            case "compaction_summary_chunk":
            case "session_message_chunk": {
                const content = await this.#content(sessionTarget, update.content, signal);
                return {
                    agent: { ...update, content: content.agent },
                    events: [
                        { ...update, content: content.event },
                        // Keep native text intact. Only add cards for exact file URLs whose
                        // original upload metadata is still known; arbitrary context stays text.
                        ...(update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
                            ? this.#resourceLinks(update.content.text).map((content) => ({ ...update, content }))
                            : []),
                    ],
                };
            }
            case "tool_call":
            case "tool_call_update":
                return await this.#toolUpdate(sessionTarget, update, signal);
            case "compaction_update": {
                if (update.summary === undefined || update.summary === null) {
                    return { agent: update, events: [update] };
                }
                const content = await Promise.all(
                    update.summary.map(async (item) => await this.#content(sessionTarget, item, signal)),
                );
                return {
                    agent: { ...update, summary: content.map((item) => item.agent) },
                    events: [{ ...update, summary: content.map((item) => item.event) }],
                };
            }
            case "session_message": {
                if (update.content === undefined || update.content === null) {
                    return { agent: update, events: [update] };
                }
                const content = await Promise.all(
                    update.content.map(async (item) => await this.#content(sessionTarget, item, signal)),
                );
                return {
                    agent: { ...update, content: content.map((item) => item.agent) },
                    events: [{ ...update, content: content.map((item) => item.event) }],
                };
            }
            case "plan":
            case "available_commands_update":
            case "current_mode_update":
            case "config_option_update":
            case "session_info_update":
            case "usage_update":
            case "notice":
            case "subagent_update":
                return { agent: update, events: [update] };
            case "plan_update":
            case "plan_removed":
            case "prompt_suggestions_update":
                // Morty advertises neither the plan nor the prompt suggestions capability, so these never reach a
                // Session's events.
                return { agent: update, events: [] };
        }
    };
}
